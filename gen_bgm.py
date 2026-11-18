#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原创治愈系 BGM 合成器 (qianfeiwanyu original BGM generator)
纯程序化生成：和弦进行 + 分解琶音 + 低音 + pad + 点缀旋律 + 卷积混响。
所有音符由算法按音阶与和声规则生成，不采样、不引用任何现有曲目旋律，
生成结果可自由再分发。

用法:
  python gen_bgm.py --test          # 只生成 20 秒样本到 ./_test
  python gen_bgm.py --all           # 生成全部 12 首到目标目录
"""
import argparse, math, os, subprocess, sys
import numpy as np
from scipy.signal import fftconvolve, butter, lfilter

SR = 48000
TAU = 2 * math.pi

def midi2freq(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))

# ---------- 和声素材（半音相对根音）----------
MAJ_POP   = [[0,4,7],[7,11,14],[9,12,16],[5,9,12]]          # I-V-vi-IV
MAJ_VI    = [[0,4,7],[9,12,16],[5,9,12],[7,11,14]]          # I-vi-IV-V
MAJ_CLASS = [[0,4,7],[5,9,12],[7,11,14],[0,4,7]]            # I-IV-V-I
MIN_POP   = [[0,3,7],[8,12,15],[3,7,10],[10,14,17]]         # i-VI-III-VII
MIN_SAD   = [[0,3,7],[5,8,12],[8,12,15],[7,11,14]]          # i-iv-VI-V
MIN_FLOW  = [[0,3,7],[10,14,17],[8,12,15],[7,11,14]]        # i-VII-VI-V

SCALE_MAJ = [0,2,4,5,7,9,11]
SCALE_MIN = [0,2,3,5,7,8,10]
PENTA_MAJ = [0,2,4,7,9]

# ---------- 包络 ----------
def env_ad(n, a, d, s, r, sr):
    n = max(n, 1)
    raw = [max(a*sr,1.0), max(d*sr,1.0), max(r*sr,1.0)]
    total = sum(raw)
    if total > n:
        scale = n/total
        raw = [max(1.0, x*scale) for x in raw]
    ai, di, ri = [int(round(x)) for x in raw]
    # 保证三段之和恰为 n
    diff = n - (ai+di+ri)
    if diff > 0: di += diff
    elif diff < 0:
        while diff < 0 and ri > 1: ri -= 1; diff += 1
        while diff < 0 and di > 1: di -= 1; diff += 1
        while diff < 0 and ai > 1: ai -= 1; diff += 1
    if ai+di+ri < n: di += n-(ai+di+ri)
    e = np.ones(n, dtype=np.float64)
    p = 0
    if ai>0: e[p:p+ai] = np.linspace(0,1,ai); p += ai
    if di>0: e[p:p+di] = np.linspace(1,s,di); p += di
    if ri>0: e[p:p+ri] = np.linspace(s,0,ri)
    return e

# ---------- 音色 ----------
def synth_note(freq, dur, kind, sr, vel=1.0):
    n = max(1, int(dur*sr))
    t = np.arange(n)/sr
    if kind == 'musicbox':
        # 音乐盒：近正弦 + 少量高次泛音，快速衰减
        y = (np.sin(TAU*freq*t)
             + 0.28*np.sin(TAU*2*freq*t)*np.exp(-6*t)
             + 0.10*np.sin(TAU*3*freq*t)*np.exp(-11*t)
             + 0.05*np.sin(TAU*5*freq*t)*np.exp(-16*t))
        e = env_ad(n, 0.004, min(0.9,dur*0.55), 0.12, 0.16, sr)
    elif kind == 'piano':
        # 钢琴：多次泛音，指数衰减
        y = (np.sin(TAU*freq*t)
             + 0.42*np.sin(TAU*2*freq*t)*np.exp(-4.5*t)
             + 0.22*np.sin(TAU*3*freq*t)*np.exp(-8*t)
             + 0.11*np.sin(TAU*4*freq*t)*np.exp(-12*t)
             + 0.05*np.sin(TAU*6*freq*t)*np.exp(-18*t))
        e = env_ad(n, 0.006, min(1.2,dur*0.6), 0.18, 0.20, sr)
    elif kind == 'bass':
        y = (np.sin(TAU*freq*t)
             + 0.30*np.sin(TAU*2*freq*t)*np.exp(-3*t))
        e = env_ad(n, 0.010, min(1.5,dur*0.5), 0.5, 0.30, sr)
    elif kind == 'pad':
        # 柔和铺底：两个失谐三角近似 + 慢起慢落
        f2 = freq*1.003
        tri = lambda f: (2/math.pi)*np.arcsin(np.sin(TAU*f*t))
        y = 0.6*tri(freq) + 0.4*tri(f2)
        e = env_ad(n, min(0.4,dur*0.3), 0.3, 0.7, min(0.8,dur*0.4), sr)
    else:
        y = np.sin(TAU*freq*t)
        e = env_ad(n, 0.01, 0.3, 0.3, 0.2, sr)
    return (y*e*vel).astype(np.float64)

# ---------- 混响脉冲 ----------
def make_ir(sr, dur=1.7, decay=3.6, seed=7):
    rng = np.random.default_rng(seed)
    n = int(sr*dur)
    t = np.arange(n)/sr
    env = np.exp(-decay*t)
    # 早期反射前 30ms 留稀疏一些
    ir_l = rng.standard_normal(n)*env
    ir_r = rng.standard_normal(n)*env
    e0 = int(0.03*sr)
    ir_l[:e0] *= np.linspace(0.2,1,e0)
    ir_r[:e0] *= np.linspace(0.2,1,e0)
    ir = np.stack([ir_l, ir_r], axis=1)
    ir /= np.sqrt(np.mean(ir**2))
    return ir

def add_note(buf, start_s, freq, dur, kind, vel, pan):
    sr = SR
    i = int(start_s*sr)
    seg = synth_note(freq, dur, kind, sr, vel)
    j = min(buf.shape[0], i+seg.shape[0])
    if i >= buf.shape[0] or j <= i:
        return
    seg = seg[:j-i]
    l = math.sqrt((1-pan)*0.5)*2
    r = math.sqrt((1+pan)*0.5)*2
    buf[i:j,0] += seg*l
    buf[i:j,1] += seg*r

# ---------- 曲目生成 ----------
def generate(cfg, out_path):
    sr = SR
    rng = np.random.default_rng(cfg['seed'])
    dur = cfg['dur']; bpm = cfg['bpm']
    root = cfg['root']; prog = cfg['prog']
    scale = cfg['scale']; kind = cfg['kind']
    beat = 60.0/bpm
    bar = beat*4
    n = int(dur*sr)
    buf = np.zeros((n,2), dtype=np.float64)

    nbars = int(math.ceil(dur/bar))+1
    for b in range(nbars):
        t0 = b*bar
        if t0 > dur: break
        chord = prog[b % len(prog)]
        # 乐句起伏：每 4 小节弱强变化
        phrase = (b//4) % 4
        dyn = [0.82, 1.0, 0.9, 1.05][phrase]

        # --- pad 铺底（每小节一个长和弦）---
        for deg in chord:
            add_note(buf, t0, midi2freq(root+deg-12), min(bar*1.05, dur-t0),
                     'pad', 0.045*dyn, pan=rng.uniform(-0.25,0.25))

        # --- 低音：根音 +  fifth ---
        add_note(buf, t0, midi2freq(root+chord[0]-24), min(bar*0.95,dur-t0),
                 'bass', 0.26*dyn, pan=0)
        add_note(buf, t0+beat*2, midi2freq(root+chord[0]-24+7), min(bar*0.45,dur-t0-beat*2),
                 'bass', 0.16*dyn, pan=0) if t0+beat*2 < dur else None

        # --- 分解琶音（八分音符，上下行 pattern）---
        pattern_up = [0,1,2,1, 0,1,2,1]
        pattern_down= [2,1,0,1, 2,1,0,1]
        pat = pattern_up if (b%2==0) else pattern_down
        for k in range(8):
            ts = t0 + k*beat*0.5
            if ts >= dur: break
            deg = chord[pat[k] % len(chord)]
            octv = 12 if k in (2,6) else 0
            mm = root + deg + octv
            if rng.random() < 0.12:   # 轻微留白
                continue
            vel = (0.15 if k%2==0 else 0.10)*dyn*rng.uniform(0.9,1.1)
            pan = -0.28 + 0.56*(k/7.0) + rng.uniform(-0.05,0.05)
            add_note(buf, ts, midi2freq(mm), min(beat*0.9, dur-ts),
                     kind, vel, pan)

        # --- 高音点缀旋律（五声音阶，稀疏、落在和弦音附近）---
        if rng.random() < 0.85:
            for _ in range(rng.integers(1,3)):
                slot = int(rng.integers(0,8))
                ts = t0 + slot*beat*0.5
                if ts >= dur: break
                # 从音阶取中高音，靠和弦音
                base = root + chord[0] + 24
                cand = [base+s for s in PENTA_MAJ if s <= 12] + [base+12+s for s in PENTA_MAJ[:3]]
                mm = cand[int(rng.integers(0,len(cand)))]
                add_note(buf, ts, midi2freq(mm), min(beat*1.4, dur-ts),
                         'musicbox', 0.075*dyn*rng.uniform(0.8,1.2),
                         pan=rng.uniform(-0.4,0.4))

    # --- 混响 ---
    ir = make_ir(sr, seed=cfg['seed'])
    wet = np.empty_like(buf)
    for ch in range(2):
        wet[:,ch] = fftconvolve(buf[:,ch], ir[:,ch])[:n]
    wet /= (np.max(np.abs(wet))+1e-9)
    mix = buf*0.86 + wet*0.20
    # 低通柔化（一阶 IIR，去毛刺）——用 scipy 向量化，避免逐样本 Python 循环
    alpha = 0.72
    b = np.array([1-alpha], dtype=np.float64)
    a = np.array([1.0, -alpha], dtype=np.float64)
    for ch in range(2):
        mix[:,ch] = lfilter(b, a, mix[:,ch])

    # --- 首尾淡入淡出 ---
    fi = min(int(1.5*sr), n//4); fo = min(int(2.0*sr), n//4)
    if fi>0: mix[:fi] *= np.linspace(0,1,fi)[:,None]
    if fo>0: mix[-fo:] *= np.linspace(1,0,fo)[:,None]

    peak = np.max(np.abs(mix))+1e-9
    mix = mix/peak*0.89
    pcm = (mix.astype(np.float32))
    raw = os.path.join(os.path.dirname(out_path), '_raw_f32.raw')
    pcm.astype('<f4').tofile(raw)
    subprocess.run(['ffmpeg','-y','-loglevel','error',
                    '-f','f32le','-ar',str(sr),'-ac','2','-i',raw,
                    '-c:a','libvorbis','-q:a','5', out_path], check=True)
    os.remove(raw)
    return dur

# ---------- 曲目表 ----------
# root 用 MIDI 音高；prog 和弦进行；scale 仅影响点缀；kind 主音色
TRACKS = {
 'morning1': dict(root=60, prog=MAJ_POP,   scale=SCALE_MAJ, kind='musicbox', bpm=84, dur=112, seed=101),
 'morning2': dict(root=62, prog=MAJ_VI,    scale=SCALE_MAJ, kind='piano',    bpm=80, dur=118, seed=102),
 'day1':     dict(root=61, prog=MAJ_POP,   scale=SCALE_MAJ, kind='piano',    bpm=92, dur=96,  seed=103),
 'day2':     dict(root=59, prog=MAJ_CLASS, scale=SCALE_MAJ, kind='musicbox', bpm=96, dur=92,  seed=104),
 'day3':     dict(root=64, prog=MAJ_VI,    scale=SCALE_MAJ, kind='piano',    bpm=88, dur=100, seed=105),
 'dusk1':    dict(root=57, prog=MAJ_VI,    scale=SCALE_MAJ, kind='piano',    bpm=72, dur=128, seed=106),
 'dusk2':    dict(root=60, prog=MAJ_CLASS, scale=SCALE_MAJ, kind='musicbox', bpm=70, dur=132, seed=107),
 'night1':   dict(root=55, prog=MIN_POP,   scale=SCALE_MIN, kind='piano',    bpm=64, dur=126, seed=108),
 'night2':   dict(root=57, prog=MAJ_CLASS, scale=SCALE_MAJ, kind='musicbox', bpm=66, dur=122, seed=109),
 'menu':     dict(root=60, prog=MAJ_POP,   scale=SCALE_MAJ, kind='musicbox', bpm=90, dur=150, seed=110),
 'warm':     dict(root=62, prog=MAJ_VI,    scale=SCALE_MAJ, kind='piano',    bpm=76, dur=124, seed=111),
 'sad':      dict(root=55, prog=MIN_SAD,   scale=SCALE_MIN, kind='piano',    bpm=60, dur=140, seed=112),
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--test', action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--dir', default=None)
    args = ap.parse_args()
    if args.test:
        outdir = os.path.abspath('./_test_bgm'); os.makedirs(outdir, exist_ok=True)
        cfg = dict(TRACKS['morning1']); cfg['dur'] = 20
        p = os.path.join(outdir,'morning1.ogg')
        print('generating test ->', p, flush=True)
        generate(cfg, p); print('done', os.path.getsize(p),'bytes', flush=True)
        return
    if args.all:
        outdir = os.path.abspath(args.dir or './_out_bgm'); os.makedirs(outdir, exist_ok=True)
        for name,cfg in TRACKS.items():
            p = os.path.join(outdir, name+'.ogg')
            print(f'[{name}] dur={cfg["dur"]}s root={cfg["root"]} bpm={cfg["bpm"]} ...', flush=True)
            generate(cfg, p)
            print(f'  -> {os.path.getsize(p)//1024} KB', flush=True)
        print('ALL DONE', outdir, flush=True)
        return
    ap.print_help()

if __name__ == '__main__':
    main()
