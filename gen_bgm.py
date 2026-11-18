#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原创多风格 BGM 合成器 v2 (qianfeiwanyu original BGM generator)
纯程序化生成：12 首曲目各自拥有独立的音色 / 节奏型 / 织体 / 和声语言，
不采样、不引用任何现有曲目旋律，生成结果可自由再分发。

风格分配：
  morning1 晨光音乐盒   morning2 晨露拨弦
  day1 晴天钢琴流行     day2 午后明亮拨弦   day3 日光竖琴琶音
  dusk1 黄昏爵士        dusk2 晚霞弦乐
  night1 夜空氛围       night2 月夜钢琴夜曲
  menu  8-bit 俏皮      warm  温暖电钢      sad   忧伤慢板

用法:
  python gen_bgm.py --test          # 只生成 20 秒样本
  python gen_bgm.py --all --dir DIR # 生成全部 12 首
"""
import argparse, math, os, subprocess, sys
import numpy as np
from scipy.signal import fftconvolve

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
JAZZ7     = [[0,4,7,11],[5,9,12,15],[9,12,16,19],[2,5,9,12]]# I7-IV7-vi7-ii7
WARM7     = [[0,4,7,11],[9,12,16,19],[5,9,12,16],[7,11,14,17]]# Imaj7-vi7-IVmaj7-V7

SCALE_MAJ = [0,2,4,5,7,9,11]
SCALE_MIN = [0,2,3,5,7,8,10]
PENTA_MAJ = [0,2,4,7,9]
PENTA_MIN = [0,3,5,7,10]

# ---------- 包络 ----------
def env_ad(n, a, d, s, r, sr):
    n = max(n, 1)
    raw = [max(a*sr,1.0), max(d*sr,1.0), max(r*sr,1.0)]
    total = sum(raw)
    if total > n:
        scale = n/total
        raw = [max(1.0, x*scale) for x in raw]
    ai, di, ri = [int(round(x)) for x in raw]
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

def tri_wave(t, f):
    return (2/math.pi)*np.arcsin(np.sin(TAU*f*t))

# ---------- 音色 ----------
def synth_note(freq, dur, kind, sr, vel=1.0, rng=None):
    n = max(1, int(dur*sr))
    t = np.arange(n)/sr
    if kind == 'musicbox':
        y = (np.sin(TAU*freq*t)
             + 0.28*np.sin(TAU*2*freq*t)*np.exp(-6*t)
             + 0.10*np.sin(TAU*3*freq*t)*np.exp(-11*t)
             + 0.05*np.sin(TAU*5*freq*t)*np.exp(-16*t))
        e = env_ad(n, 0.004, min(0.9,dur*0.55), 0.12, 0.16, sr)
    elif kind == 'piano':
        y = (np.sin(TAU*freq*t)
             + 0.42*np.sin(TAU*2*freq*t)*np.exp(-4.5*t)
             + 0.22*np.sin(TAU*3*freq*t)*np.exp(-8*t)
             + 0.11*np.sin(TAU*4*freq*t)*np.exp(-12*t)
             + 0.05*np.sin(TAU*6*freq*t)*np.exp(-18*t))
        e = env_ad(n, 0.006, min(1.2,dur*0.6), 0.18, 0.20, sr)
    elif kind == 'pluck':
        # 拨弦：锯齿谐波 + 快速衰减 + 起音噪声
        y = (np.sin(TAU*freq*t)
             + 0.5*np.sin(TAU*2*freq*t)*np.exp(-7*t)
             + 0.30*np.sin(TAU*3*freq*t)*np.exp(-12*t)
             + 0.16*np.sin(TAU*4*freq*t)*np.exp(-18*t))
        if rng is not None and n > 200:
            y[:200] += 0.18*rng.standard_normal(200)*np.exp(-np.arange(200)/40.0)
        e = env_ad(n, 0.003, min(0.6,dur*0.5), 0.10, 0.12, sr)
    elif kind == 'epiano':
        # 电钢：正弦 + 二/四次泛音，FM 感，中等衰减
        y = (np.sin(TAU*freq*t)
             + 0.32*np.sin(TAU*2*freq*t)*np.exp(-5*t)
             + 0.14*np.sin(TAU*4*freq*t)*np.exp(-10*t))
        e = env_ad(n, 0.008, min(1.0,dur*0.6), 0.30, 0.24, sr)
    elif kind == 'marimba':
        y = (np.sin(TAU*freq*t)
             + 0.32*np.sin(TAU*4*freq*t)*np.exp(-14*t)
             + 0.10*np.sin(TAU*9*freq*t)*np.exp(-22*t))
        e = env_ad(n, 0.003, min(0.5,dur*0.45), 0.08, 0.14, sr)
    elif kind == 'harp':
        y = (np.sin(TAU*freq*t)
             + 0.40*np.sin(TAU*2*freq*t)*np.exp(-9*t)
             + 0.20*np.sin(TAU*3*freq*t)*np.exp(-15*t)
             + 0.08*np.sin(TAU*5*freq*t)*np.exp(-22*t))
        e = env_ad(n, 0.002, min(0.5,dur*0.5), 0.06, 0.12, sr)
    elif kind == 'bell':
        # 钟琴/风铃：非谐波泛音
        y = (np.sin(TAU*freq*t)
             + 0.5*np.sin(TAU*2.76*freq*t)*np.exp(-4*t)
             + 0.28*np.sin(TAU*5.4*freq*t)*np.exp(-7*t)
             + 0.14*np.sin(TAU*8.9*freq*t)*np.exp(-11*t))
        e = env_ad(n, 0.002, min(1.0,dur*0.55), 0.05, 0.5, sr)
    elif kind == 'flute':
        # 长笛：纯正弦 + 气声 + 慢起 + 颤音
        vib = 1 + 0.006*np.sin(TAU*5.0*t)
        y = np.sin(TAU*freq*vib*t) + 0.06*np.sin(TAU*2*freq*vib*t)
        if rng is not None:
            y += 0.02*rng.standard_normal(n)
        e = env_ad(n, min(0.18,dur*0.25), 0.3, 0.85, min(0.35,dur*0.35), sr)
    elif kind == 'strings':
        # 弦乐长音：锯齿 + 慢起 + 颤音 + 低通感
        vib = 1 + 0.004*np.sin(TAU*4.8*t)
        y = (tri_wave(t, freq*vib)*0.6
             + tri_wave(t, freq*vib*1.004)*0.4
             + 0.15*np.sin(TAU*2*freq*vib*t))
        e = env_ad(n, min(0.35,dur*0.35), 0.25, 0.82, min(0.7,dur*0.45), sr)
    elif kind == 'square':
        # 8-bit 方波
        y = np.sign(np.sin(TAU*freq*t))*0.6 + 0.15*np.sign(np.sin(TAU*2*freq*t))
        e = env_ad(n, 0.002, min(0.5,dur*0.5), 0.55, 0.08, sr)
    elif kind == 'bass':
        y = (np.sin(TAU*freq*t) + 0.30*np.sin(TAU*2*freq*t)*np.exp(-3*t))
        e = env_ad(n, 0.010, min(1.5,dur*0.5), 0.5, 0.30, sr)
    elif kind == 'pad':
        f2 = freq*1.003
        y = 0.6*tri_wave(t, freq) + 0.4*tri_wave(t, f2)
        e = env_ad(n, min(0.4,dur*0.3), 0.3, 0.7, min(0.8,dur*0.4), sr)
    else:
        y = np.sin(TAU*freq*t)
        e = env_ad(n, 0.01, 0.3, 0.3, 0.2, sr)
    return (y*e*vel).astype(np.float64)

def synth_drum(kind, dur, sr, rng):
    n = max(1, int(dur*sr)); t = np.arange(n)/sr
    if kind == 'kick':
        f = 120*np.exp(-28*t) + 48
        ph = TAU*np.cumsum(f)/sr
        y = np.sin(ph)*np.exp(-16*t)
    elif kind == 'hat':
        noise = rng.standard_normal(n)
        # 简易高通：差分
        hp = np.diff(noise, prepend=noise[0])
        y = hp*np.exp(-45*t)*0.5
    elif kind == 'snare':
        noise = rng.standard_normal(n)
        y = (noise*0.7 + np.sin(TAU*190*t)*0.5)*np.exp(-22*t)
    elif kind == 'brush':
        noise = rng.standard_normal(n)
        hp = np.diff(noise, prepend=noise[0])
        y = hp*np.exp(-28*t)*0.22
    else:
        y = np.zeros(n)
    return y

def make_ir(sr, dur=1.7, decay=3.6, seed=7):
    rng = np.random.default_rng(seed)
    n = int(sr*dur); t = np.arange(n)/sr
    env = np.exp(-decay*t)
    ir_l = rng.standard_normal(n)*env
    ir_r = rng.standard_normal(n)*env
    e0 = int(0.03*sr)
    ir_l[:e0] *= np.linspace(0.2,1,e0)
    ir_r[:e0] *= np.linspace(0.2,1,e0)
    ir = np.stack([ir_l, ir_r], axis=1)
    ir /= np.sqrt(np.mean(ir**2))
    return ir

# ---------- 曲目表 ----------
TRACKS = {
 'morning1': dict(root=60, prog=MAJ_POP,   style='musicbox_airy', bpm=72,  dur=110, seed=201, scale=PENTA_MAJ),
 'morning2': dict(root=62, prog=MAJ_VI,    style='pluck_folk',    bpm=82,  dur=116, seed=202, scale=SCALE_MAJ),
 'day1':     dict(root=61, prog=MAJ_POP,   style='piano_pop',     bpm=96,  dur=100, seed=203, scale=SCALE_MAJ),
 'day2':     dict(root=59, prog=MAJ_CLASS, style='pluck_bright',  bpm=100, dur=98,  seed=204, scale=PENTA_MAJ),
 'day3':     dict(root=64, prog=MAJ_VI,    style='arp_sun',       bpm=108, dur=104, seed=205, scale=SCALE_MAJ),
 'dusk1':    dict(root=57, prog=JAZZ7,     style='jazz_dusk',     bpm=76,  dur=126, seed=206, scale=SCALE_MAJ),
 'dusk2':    dict(root=60, prog=MAJ_CLASS, style='strings_dusk',  bpm=68,  dur=130, seed=207, scale=SCALE_MAJ),
 'night1':   dict(root=55, prog=MIN_POP,   style='ambient_night', bpm=56,  dur=130, seed=208, scale=PENTA_MIN),
 'night2':   dict(root=57, prog=MIN_SAD,   style='nocturne',      bpm=60,  dur=124, seed=209, scale=SCALE_MIN),
 'menu':     dict(root=60, prog=MAJ_VI,    style='chip_playful',  bpm=120, dur=100, seed=210, scale=SCALE_MAJ),
 'warm':     dict(root=62, prog=WARM7,     style='warm_epiano',   bpm=74,  dur=124, seed=211, scale=SCALE_MAJ),
 'sad':      dict(root=55, prog=MIN_SAD,   style='sad_ballad',    bpm=52,  dur=138, seed=212, scale=SCALE_MIN),
}

# ---------- 编排 ----------
def arrange(buf, cfg, rng, add, drum):
    style = cfg['style']
    root, prog, scale = cfg['root'], cfg['prog'], cfg['scale']
    beat = 60.0/cfg['bpm']; bar = beat*4
    dur = cfg['dur']
    nbars = int(math.ceil(dur/bar))+1

    for b in range(nbars):
        t0 = b*bar
        if t0 >= dur: break
        chord = prog[b % len(prog)]
        dyn = [0.85,1.0,0.9,1.04][(b//4)%4]

        # ---- 晨光音乐盒：极简、通透、稀疏 ----
        if style == 'musicbox_airy':
            for deg in chord[:3]:
                add(t0, midi2freq(root+deg-12), bar*1.02, 'pad', 0.022*dyn, rng.uniform(-0.2,0.2))
            add(t0, midi2freq(root+chord[0]-24), bar*0.9, 'bass', 0.13*dyn, 0)
            for k in range(2):
                ts = t0 + k*beat*2 + rng.uniform(0,beat*0.4)
                if ts>=dur: break
                deg = chord[int(rng.integers(0,len(chord)))]
                add(ts, midi2freq(root+deg+12), beat*1.2,'musicbox',0.16*dyn,rng.uniform(-0.4,0.4))
            if rng.random()<0.5:
                ts=t0+beat*3
                if ts<dur: add(ts, midi2freq(root+chord[0]+24), beat*1.5,'bell',0.05*dyn,rng.uniform(-0.3,0.3))

        # ---- 晨露拨弦：分解和弦 + 长笛 ----
        elif style == 'pluck_folk':
            for deg in chord[:3]:
                add(t0, midi2freq(root+deg-12), bar*1.0,'pad',0.02*dyn,rng.uniform(-0.15,0.15))
            add(t0, midi2freq(root+chord[0]-24),bar*0.9,'bass',0.2*dyn,0)
            pat=[0,1,2,1,0,2,1,2]
            for k in range(8):
                ts=t0+k*beat*0.5
                if ts>=dur:break
                deg=chord[pat[k]%len(chord)]
                add(ts,midi2freq(root+deg),beat*0.8,'pluck',(0.13 if k%2==0 else 0.09)*dyn,-0.3+0.6*(k/7))
            if rng.random()<0.6:
                ts=t0+beat*2
                if ts<dur: add(ts,midi2freq(root+chord[0]+12),beat*2.2,'flute',0.08*dyn,rng.uniform(-0.2,0.2))

        # ---- 晴天钢琴流行：柱式和弦 + 琶音 + 轻打击 ----
        elif style == 'piano_pop':
            for deg in chord[:3]:
                add(t0,midi2freq(root+deg-12),bar*0.5,'pad',0.02*dyn,0)
            add(t0,midi2freq(root+chord[0]-24),bar*0.9,'bass',0.24*dyn,0)
            # 柱式和弦（第 1、3 拍）
            for bt in (0,2):
                ts=t0+bt*beat
                if ts>=dur:break
                for deg in chord:
                    add(ts,midi2freq(root+deg),beat*0.75,'piano',0.075*dyn,rng.uniform(-0.2,0.2))
            # 琶音
            for k in range(8):
                ts=t0+k*beat*0.5
                if ts>=dur:break
                deg=chord[[0,1,2,1,0,2,1,2][k]%len(chord)]
                add(ts,midi2freq(root+deg+12),beat*0.6,'piano',0.055*dyn,rng.uniform(-0.35,0.35))
            drum(t0,'kick',0.5*dyn); drum(t0+beat*2,'kick',0.42*dyn)
            for k in range(8): drum(t0+k*beat*0.5,'hat',0.12*dyn)

        # ---- 午后明亮拨弦：切分 + 马林巴 ----
        elif style == 'pluck_bright':
            add(t0,midi2freq(root+chord[0]-24),bar*0.9,'bass',0.22*dyn,0)
            offsets=[0,0.75,1.5,2,2.75,3.5]
            for i,bt in enumerate(offsets):
                ts=t0+bt*beat
                if ts>=dur:break
                deg=chord[i%len(chord)]
                add(ts,midi2freq(root+deg+12),beat*0.7,'marimba',0.14*dyn,-0.35+0.7*(i/5))
            for k in range(4): drum(t0+k*beat,'hat',0.1*dyn)

        # ---- 日光竖琴琶音：流动十六分 ----
        elif style == 'arp_sun':
            for deg in chord[:3]:
                add(t0,midi2freq(root+deg-12),bar*1.0,'pad',0.018*dyn,0)
            add(t0,midi2freq(root+chord[0]-24),bar*0.9,'bass',0.18*dyn,0)
            for k in range(16):
                ts=t0+k*beat*0.25
                if ts>=dur:break
                seq=[0,1,2,1, 0,2,1,2, 0,1,2,1, 0,2,1,2]
                deg=chord[seq[k]%len(chord)]
                octv=12 if k%8>=4 else 0
                add(ts,midi2freq(root+deg+octv),beat*0.35,'harp',(0.10 if k%2==0 else 0.07)*dyn,-0.4+0.8*(k/15))
            drum(t0,'kick',0.4*dyn)

        # ---- 黄昏爵士：七和弦 + walking bass + 刷镲 swing ----
        elif style == 'jazz_dusk':
            # 电钢七和弦切分（第 1、2.5、4 拍）
            for bt in (0,1.5,3):
                ts=t0+bt*beat
                if ts>=dur:break
                for deg in chord:
                    add(ts,midi2freq(root+deg),beat*0.9,'epiano',0.055*dyn,rng.uniform(-0.25,0.25))
            # walking bass 每拍
            for k in range(4):
                ts=t0+k*beat
                if ts>=dur:break
                deg=chord[0] if k in (0,3) else chord[min(k,len(chord)-1)]
                add(ts,midi2freq(root+deg-24),beat*0.85,'bass',0.2*dyn,0)
            # swing 刷镲
            for k in range(8):
                ts=t0+k*beat*0.5+(beat*0.12 if k%2 else 0)
                if ts<dur: drum(ts,'brush',0.5*dyn if k%2 else 0.35*dyn)
            if rng.random()<0.5:
                ts=t0+beat*2
                if ts<dur: add(ts,midi2freq(root+chord[-1]+12),beat*1.6,'flute',0.055*dyn,rng.uniform(-0.3,0.3))

        # ---- 晚霞弦乐：长音铺底 + 稀疏钢琴 ----
        elif style == 'strings_dusk':
            for deg in chord:
                add(t0,midi2freq(root+deg-12),bar*1.05,'strings',0.04*dyn,rng.uniform(-0.3,0.3))
            add(t0,midi2freq(root+chord[0]-24),bar*0.95,'bass',0.16*dyn,0)
            for k in range(2):
                ts=t0+(k*2+0.5)*beat
                if ts>=dur:break
                deg=chord[int(rng.integers(0,len(chord)))]
                add(ts,midi2freq(root+deg+12),beat*1.3,'piano',0.09*dyn,rng.uniform(-0.4,0.4))

        # ---- 夜空氛围：极简 + 大混响 ----
        elif style == 'ambient_night':
            for deg in chord:
                add(t0,midi2freq(root+deg-12),bar*1.1,'pad',0.05*dyn,rng.uniform(-0.35,0.35))
            add(t0,midi2freq(root+chord[0]-24),bar,'bass',0.12*dyn,0)
            if b%2==0:
                ts=t0+beat*2
                if ts<dur:
                    s=scale[int(rng.integers(0,len(scale)))]
                    add(ts,midi2freq(root+s+24),beat*2.5,'bell',0.05*dyn,rng.uniform(-0.5,0.5))

        # ---- 月夜夜曲：低音分解 + 装饰高音 ----
        elif style == 'nocturne':
            for deg in (chord[0], chord[-1]):
                add(t0,midi2freq(root+deg-24),bar*0.9,'bass',0.17*dyn,rng.uniform(-0.1,0.1))
            for k in range(4):
                ts=t0+k*beat
                if ts>=dur:break
                deg=chord[0] if k%2==0 else chord[min(1,len(chord)-1)]
                add(ts,midi2freq(root+deg),beat*0.8,'piano',0.10*dyn,rng.uniform(-0.2,0.2))
            # 装饰旋律
            mel=[0,2,1,2]
            for k in range(2):
                ts=t0+(k*2+0.75)*beat
                if ts>=dur:break
                s=scale[int(rng.integers(0,len(scale)))]
                add(ts,midi2freq(root+s+12+mel[k]),beat*1.1,'piano',0.07*dyn,rng.uniform(-0.4,0.4))

        # ---- 8-bit 俏皮：方波旋律 + 快琶音 + 节拍 ----
        elif style == 'chip_playful':
            add(t0,midi2freq(root+chord[0]-24),bar*0.9,'bass',0.16*dyn,0)
            for k in range(16):
                ts=t0+k*beat*0.25
                if ts>=dur:break
                deg=chord[[0,1,2,1][k%4]%len(chord)]
                octv=12 if k%4 in (0,2) else 0
                add(ts,midi2freq(root+deg+octv),beat*0.22,'square',(0.075 if k%2==0 else 0.05)*dyn,0)
            # 方波旋律
            for k in range(4):
                ts=t0+k*beat
                if ts>=dur:break
                s=scale[int(rng.integers(0,len(scale)))]
                add(ts,midi2freq(root+s+24),beat*0.7,'square',0.045*dyn,rng.uniform(-0.3,0.3))
            drum(t0,'kick',0.5*dyn); drum(t0+beat*2,'kick',0.45*dyn)
            for k in range(8): drum(t0+k*beat*0.5,'hat',0.16*dyn)

        # ---- 温暖电钢：柔和七和弦 + 拨弦 + 长笛 ----
        elif style == 'warm_epiano':
            for deg in chord:
                add(t0,midi2freq(root+deg-12),bar*1.02,'strings',0.026*dyn,rng.uniform(-0.25,0.25))
            add(t0,midi2freq(root+chord[0]-24),bar*0.9,'bass',0.18*dyn,0)
            for bt in (0,2):
                ts=t0+bt*beat
                if ts>=dur:break
                for deg in chord:
                    add(ts,midi2freq(root+deg),beat*1.1,'epiano',0.06*dyn,rng.uniform(-0.2,0.2))
            for k in range(8):
                ts=t0+k*beat*0.5
                if ts>=dur:break
                deg=chord[[0,1,2,1,0,2,1,2][k]%len(chord)]
                add(ts,midi2freq(root+deg+12),beat*0.6,'pluck',0.05*dyn,rng.uniform(-0.3,0.3))
            if rng.random()<0.5:
                ts=t0+beat*3
                if ts<dur: add(ts,midi2freq(root+chord[0]+12),beat*2,'flute',0.05*dyn,0)

        # ---- 忧伤慢板：慢速柱式钢琴 + 弦乐长音 ----
        elif style == 'sad_ballad':
            for deg in chord:
                add(t0,midi2freq(root+deg-12),bar*1.08,'strings',0.035*dyn,rng.uniform(-0.3,0.3))
            add(t0,midi2freq(root+chord[0]-24),bar,'bass',0.14*dyn,0)
            for bt in (0,2):
                ts=t0+bt*beat
                if ts>=dur:break
                for deg in chord:
                    add(ts,midi2freq(root+deg),beat*1.3,'piano',0.07*dyn,rng.uniform(-0.15,0.15))
            ts=t0+beat*1
            if ts<dur:
                s=scale[int(rng.integers(0,len(scale)))]
                add(ts,midi2freq(root+s+12),beat*2.2,'piano',0.06*dyn,rng.uniform(-0.3,0.3))

# ---------- 生成 ----------
def generate(cfg, out_path):
    sr = SR; rng = np.random.default_rng(cfg['seed'])
    dur = cfg['dur']; n = int(dur*sr)
    buf = np.zeros((n,2), dtype=np.float64)

    def add(start_s, freq, length, kind, vel, pan):
        i = int(start_s*sr)
        length = max(0.05, min(length, dur-start_s))
        if i >= n or i < 0: return
        seg = synth_note(freq, length, kind, sr, vel, rng)
        j = min(n, i+seg.shape[0]); seg = seg[:j-i]
        l = math.sqrt((1-pan)*0.5)*2; r = math.sqrt((1+pan)*0.5)*2
        buf[i:j,0] += seg*l; buf[i:j,1] += seg*r

    def drum(start_s, kind, vel):
        i = int(start_s*sr)
        if i >= n or i < 0: return
        seg = synth_drum(kind, 0.18, sr, rng)
        j = min(n, i+seg.shape[0]); seg = seg[:j-i]
        buf[i:j,0] += seg*vel; buf[i:j,1] += seg*vel

    arrange(buf, cfg, rng, add, drum)

    # 混响（风格化 wet 与衰减）
    style = cfg['style']
    rev_decay = 5.0 if style in ('ambient_night','sad_ballad','nocturne') else (2.6 if style=='chip_playful' else 3.6)
    wet_amt = 0.30 if style in ('ambient_night','sad_ballad','nocturne') else (0.10 if style=='chip_playful' else 0.18)
    ir = make_ir(sr, decay=rev_decay, seed=cfg['seed'])
    wet = np.empty_like(buf)
    for ch in range(2):
        wet[:,ch] = fftconvolve(buf[:,ch], ir[:,ch])[:n]
    wmax = np.max(np.abs(wet))+1e-9
    if wmax > 0: wet = wet/wmax
    mix = buf*0.9 + wet*wet_amt

    # 柔化（8-bit 保留方波亮度，轻低通）
    alpha = 0.55 if style=='chip_playful' else 0.72
    b = np.array([1-alpha],dtype=np.float64); a = np.array([1.0,-alpha],dtype=np.float64)
    from scipy.signal import lfilter
    for ch in range(2): mix[:,ch] = lfilter(b,a,mix[:,ch])

    fi = min(int(1.5*sr), n//4); fo = min(int(2.0*sr), n//4)
    if fi>0: mix[:fi] *= np.linspace(0,1,fi)[:,None]
    if fo>0: mix[-fo:] *= np.linspace(1,0,fo)[:,None]

    peak = np.max(np.abs(mix))+1e-9
    mix = mix/peak*0.87
    raw = os.path.join(os.path.dirname(out_path), '_raw_f32.raw')
    mix.astype(np.float32).astype('<f4').tofile(raw)
    subprocess.run(['ffmpeg','-y','-loglevel','error','-f','f32le','-ar',str(sr),'-ac','2','-i',raw,
                    '-c:a','libvorbis','-q:a','5',out_path],check=True)
    os.remove(raw)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--test',action='store_true'); ap.add_argument('--all',action='store_true')
    ap.add_argument('--dir',default=None); ap.add_argument('--only',default=None)
    args=ap.parse_args()
    if args.test:
        outdir=os.path.abspath('./_test_bgm'); os.makedirs(outdir,exist_ok=True)
        name=args.only or 'morning1'; cfg=dict(TRACKS[name]); cfg['dur']=20
        p=os.path.join(outdir,name+'.ogg')
        print('test ->',p,flush=True); generate(cfg,p)
        print('done',os.path.getsize(p),'bytes',flush=True); return
    if args.all:
        outdir=os.path.abspath(args.dir or './_out_bgm'); os.makedirs(outdir,exist_ok=True)
        for name,cfg in TRACKS.items():
            if args.only and name!=args.only: continue
            p=os.path.join(outdir,name+'.ogg')
            print(f'[{name}] style={cfg["style"]} bpm={cfg["bpm"]} ...',flush=True)
            generate(cfg,p)
            print(f'  -> {os.path.getsize(p)//1024} KB',flush=True)
        print('ALL DONE',outdir,flush=True); return
    ap.print_help()

if __name__=='__main__': main()
