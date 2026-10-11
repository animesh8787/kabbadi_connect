"""Assemble the demo video: slides + live recordings + Polly narration (+ the app's own spoken reply), then an SRT for YouTube.
Run from the repo root:  python -I video/compose.py
"""
import json, os, re, subprocess, sys

FF = "ffmpeg"
FP = "ffprobe"
W, H, FPS = 1920, 1080, 30
os.makedirs("video/out/seg", exist_ok=True)

narr = json.load(open("video/narration.json", encoding="utf-8"))
man = {m["name"]: m for m in json.load(open("video/clips/manifest.json", encoding="utf-8"))}


def dur(path):
    return float(subprocess.run([FP, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def run(args):
    r = subprocess.run([FF, "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        print(r.stderr)
        sys.exit(1)


ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS), "-an"]
PHONE_H = 940


def slide_seg(img, d, out):
    run(["-loop", "1", "-t", f"{d:.3f}", "-i", img, "-vf", f"scale={W}:{H},fps={FPS},format=yuv420p", *ENC, out])


def desktop_seg(clip, ss, length, d, out, speed=1.0):
    # whole-screen recording (1280x720) scaled to 1080p; hold the last frame if the scene is longer than the clip
    pad = max(0.0, d - length / speed)
    run(["-ss", f"{ss:.3f}", "-t", f"{length:.3f}", "-i", clip, "-vf", f"setpts=PTS/{speed},fps={FPS},scale={W}:{H},tpad=stop_mode=clone:stop_duration={pad:.3f},trim=duration={d:.3f},setpts=PTS-STARTPTS,format=yuv420p", *ENC, out])


def phone_seg(bg, clip, ss, length, d, out, speed=1.0):
    pad = max(0.0, d - length / speed)
    fc = (
        f"[1:v]setpts=PTS/{speed},fps={FPS},scale=-2:{PHONE_H},pad=iw+20:ih+20:10:10:color=#2a241c,"
        f"tpad=stop_mode=clone:stop_duration={pad:.3f},trim=duration={d:.3f},setpts=PTS-STARTPTS[p];"
        f"[0:v]scale={W}:{H},fps={FPS}[b];[b][p]overlay=x=W-w-130:y=(H-h)/2:shortest=1,format=yuv420p"
    )
    run(["-loop", "1", "-t", f"{d:.3f}", "-i", bg, "-ss", f"{ss:.3f}", "-t", f"{length:.3f}", "-i", clip, "-filter_complex", fc, *ENC, out])


def concat(parts, out):
    lst = out + ".txt"
    open(lst, "w").write("".join(f"file '{os.path.abspath(p).replace(chr(92), '/')}'\n" for p in parts))
    run(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])


def fade(src, out, d):
    run(["-i", src, "-vf", f"fade=t=in:st=0:d=0.3,fade=t=out:st={d - 0.3:.3f}:d=0.3", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-an", out])


N = {k: dur(f"video/audio/{k}.mp3") for k in narr}
scenes = []  # (name, narration key, duration, [app audio (file, offset)])


def build(name, key, segs, d, apps=()):
    parts = []
    for i, s in enumerate(segs):
        o = f"video/out/seg/{name}_{i}.mp4"
        s(o)
        parts.append(o)
    raw = f"video/out/seg/{name}.mp4"
    concat(parts, raw) if len(parts) > 1 else os.replace(parts[0], raw)
    out = f"video/out/seg/{name}_f.mp4"
    fade(raw, out, d)
    scenes.append((name, key, d, list(apps), out))


# 1 problem: title slide then the live landing page
d1 = N["s1_problem"] + 0.5
L = man["landing"]
build("s1", "s1_problem", [lambda o: slide_seg("video/slides/title.png", 11.0, o), lambda o: desktop_seg(L["file"], L["start"], L["length"], d1 - 11.0, o)], d1)

# 2 household
H2 = man["household"]
d2 = max(N["s2_household"] + 0.5, H2["length"])
build("s2", "s2_household", [lambda o: phone_seg("video/slides/bg_household.png", H2["file"], H2["start"], H2["length"], d2, o)], d2)

# 3 card: admin prints it, collector opens it
A = man["admin_card"]
V = man["voice"]
CARD_TAIL = 3.4  # seconds of the voice clip used here (the collector app, already signed in)
d3 = N["s3_card"] + 0.5
build(
    "s3",
    "s3_card",
    [
        lambda o: phone_seg("video/slides/bg_card.png", A["file"], A["start"], A["length"], A["length"], o),
        lambda o: phone_seg("video/slides/bg_card.png", V["file"], V["start"], CARD_TAIL, d3 - A["length"], o),
    ],
    d3,
)

# 4 voice: rest of the voice clip; the app's real Hindi reply plays after the narration
d4 = V["length"] - CARD_TAIL
apps4 = [(a["file"], max(a["at"] - CARD_TAIL + 0.5, N["s4_voice"] + 0.3)) for a in V["audios"][:1]]
build("s4", "s4_voice", [lambda o: phone_seg("video/slides/bg_voice.png", V["file"], V["start"] + CARD_TAIL, V["length"] - CARD_TAIL, d4, o)], d4, apps4)

# 5 navigation: the real walk, sped up to fit
Nv = man["nav"]
d5 = N["s5_nav"] + 0.6
build("s5", "s5_nav", [lambda o: phone_seg("video/slides/bg_nav.png", Nv["file"], Nv["start"], Nv["length"], d5, o, speed=Nv["length"] / d5)], d5)

# 6 architecture and services
d6 = N["s6_arch"] + 0.5
first = 13.0
build("s6", "s6_arch", [lambda o: slide_seg("video/slides/arch.png", first, o), lambda o: slide_seg("video/slides/services.png", d6 - first, o)], d6)

# 7 impact: methodology page
M = man["methodology"]
d7 = N["s7_impact"] + 0.6
build("s7", "s7_impact", [lambda o: desktop_seg(M["file"], M["start"], M["length"], d7, o)], d7)

# 8 tests, 9 lessons, 10 close
d8 = N["s9_tests"] + 0.5
build("s8", "s9_tests", [lambda o: slide_seg("video/slides/tests.png", d8, o)], d8)
d9 = N["s10_lessons"] + 0.5
build("s9", "s10_lessons", [lambda o: slide_seg("video/slides/lessons.png", d9, o)], d9)
d10 = N["s8_learn"] + 1.0
build("s10", "s8_learn", [lambda o: slide_seg("video/slides/close.png", d10, o)], d10)

# ---- picture
concat([s[4] for s in scenes], "video/out/picture.mp4")

# ---- sound: narration at each scene start, plus the app's own reply
inputs, filters, labels = [], [], []
t = 0.0
starts = []
for name, key, d, apps, _ in scenes:
    starts.append(t)
    inputs += ["-i", f"video/audio/{key}.mp3"]
    i = len(labels)
    filters.append(f"[{i}:a]adelay={int((t + 0.25) * 1000)}|{int((t + 0.25) * 1000)},volume=1.0[a{i}]")
    labels.append(f"[a{i}]")
    for f, off in apps:
        inputs += ["-i", f]
        i = len(labels)
        filters.append(f"[{i}:a]adelay={int((t + off) * 1000)}|{int((t + off) * 1000)},volume=0.9[a{i}]")
        labels.append(f"[a{i}]")
    t += d
total = t
fc = ";".join(filters) + f";{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
run([*inputs, "-filter_complex", fc, "-map", "[aout]", "-t", f"{total:.3f}", "-c:a", "aac", "-b:a", "192k", "video/out/sound.m4a"])

run(["-i", "video/out/picture.mp4", "-i", "video/out/sound.m4a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", "video/out/KabadiConnect_demo.mp4"])

# ---- captions (SRT) from the narration, timed in proportion to each segment
def stamp(x):
    h, r = divmod(x, 3600)
    m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s % 1) * 1000):03d}"


srt, n = [], 1
for (name, key, d, apps, _), t0 in zip(scenes, starts):
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", narr[key]) if s.strip()]
    total_chars = sum(len(s) for s in sents)
    cur = t0 + 0.25
    for s in sents:
        span = N[key] * len(s) / total_chars
        srt.append(f"{n}\n{stamp(cur)} --> {stamp(cur + span)}\n{s}\n")
        cur += span
        n += 1
open("video/out/captions.srt", "w", encoding="utf-8").write("\n".join(srt))
print("length", round(total, 1), "s ->", "video/out/KabadiConnect_demo.mp4")
