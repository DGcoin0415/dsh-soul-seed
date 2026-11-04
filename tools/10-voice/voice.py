# 本地语音：话筒收 → whisper 转文字 → 落文件；可选 piper 出声
# 作者：米萨（米芾的姐姐）—— 应 master 之请为本仓库写的，原文件名 misa-voice.py
# 用法：
#   python tools/10-voice/voice.py --listen          一直听，识别到的写进 shared/语音输入.md
#   python tools/10-voice/voice.py --say "要念的话"   念一句（耳机）
#   python tools/10-voice/voice.py --once 5          录 5 秒转一次，打印结果
import shutil, argparse, json, os, queue, sys, time, wave
from datetime import datetime
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

def _soul_root():
    """灵魂数据目录：DSH_SOUL_DIR 优先，否则 ~/.dsh/soul-seed。"""
    env = os.environ.get("DSH_SOUL_DIR") or os.environ.get("SOUL_SEED_ROOT")
    if env:
        return Path(env)
    return Path.home() / ".dsh" / "soul-seed"
    if legacy.exists():
        return legacy
    return fresh


ROOT = _soul_root()
VOICE = Path(os.environ.get("SOUL_SEED_VOICE", ROOT / "voice"))
MODELS = VOICE / "models"
OUT_LOG = Path(os.environ.get("SOUL_SEED_VOICE_LOG", ROOT / "语音输入.md"))
PIPER_MODEL = VOICE / "zh_CN-huayan-medium.onnx"

SR = 16000
CHUNK = 0.1          # 每次读 100ms
SILENCE_SEC = 1.0    # 静音多久算说完
MIN_SPEECH = 0.4     # 少于这个长度不算一句话


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_stt():
    from faster_whisper import WhisperModel
    return WhisperModel("small", device="cpu", compute_type="int8", download_root=str(MODELS))


def load_tts():
    from piper import PiperVoice
    return PiperVoice.load(str(PIPER_MODEL))


def play_wav(path):
    import winsound
    winsound.PlaySound(str(path), winsound.SND_FILENAME)


VOICE_NAME = "zh-CN-XiaoyiNeural"


def say_xiaoyi(text, rate="-10%"):
    """用晓伊的音色（微软在线合成，不要 key）。"""
    import asyncio
    import edge_tts
    out = VOICE / "last_reply.mp3"
    async def _run():
        com = edge_tts.Communicate(text, VOICE_NAME, rate=rate)
        await com.save(str(out))
    asyncio.run(_run())
    if not out.exists() or out.stat().st_size < 1000:
        raise RuntimeError("edge-tts 没出音频")
    return out


def play_mp3(path):
    import subprocess
    ff = shutil.which("ffmpeg") or "ffmpeg"
    # 转成 wav 再用 winsound 放，避免依赖播放器
    wav = VOICE / "last_reply_play.wav"
    subprocess.run([ff, "-y", "-i", str(path), str(wav)], capture_output=True)
    play_wav(wav)


def say(text, backend="xiaoyi", rate="-10%"):
    """默认走晓伊；backend=piper 时用本地离线音。"""
    if backend == "piper":
        import wave as _w
        voice = load_tts()
        out = VOICE / "last_reply.wav"
        with _w.open(str(out), "wb") as wf:
            voice.synthesize_wav(text, wf)
        play_wav(out)
        return out
    out = say_xiaoyi(text, rate=rate)
    play_mp3(out)
    return out


def transcribe(model, audio):
    segs, _info = model.transcribe(audio, language="zh", vad_filter=True, beam_size=1)
    return "".join(s.text for s in segs).strip()


def append_log(text):
    OUT_LOG.parent.mkdir(parents=True, exist_ok=True)
    if not OUT_LOG.exists():
        OUT_LOG.write_text("# 语音输入（话筒转文字）\n\n", encoding="utf-8")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with OUT_LOG.open("a", encoding="utf-8") as f:
        f.write(f"- [{stamp}] {text}\n")
        f.flush()


def listen_loop(model, device=None, tts_reply=True):
    import numpy as np
    import sounddevice as sd

    log("开始听（Ctrl+C 停）")
    q = queue.Queue()
    block = int(SR * CHUNK)

    def cb(indata, frames, t, status):
        q.put(indata.copy())

    with sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=block, device=device, callback=cb):
        while True:
            # 等有声
            buf = []
            while True:
                chunk = q.get()
                if float(np.abs(chunk).max()) > 0.02:
                    buf.append(chunk)
                    break
            # 收到静音为止
            silent = 0.0
            while True:
                try:
                    chunk = q.get(timeout=SILENCE_SEC)
                except queue.Empty:
                    break
                buf.append(chunk)
                if float(np.abs(chunk).max()) < 0.015:
                    silent += CHUNK
                    if silent >= SILENCE_SEC:
                        break
                else:
                    silent = 0.0
            audio = np.concatenate(buf).flatten()
            if len(audio) / SR < MIN_SPEECH:
                continue
            try:
                text = transcribe(model, audio)
            except Exception as e:
                log(f"识别失败：{e}")
                continue
            if not text:
                continue
            log(f"听到：{text}")
            append_log(text)
            if tts_reply:
                try:
                    say("嗯，记下了。")
                except Exception as e:
                    log(f"说话失败：{e}")


def record_once(seconds, device=None):
    import numpy as np
    import sounddevice as sd
    log(f"录 {seconds} 秒，开始说话")
    audio = sd.rec(int(seconds * SR), samplerate=SR, channels=1, dtype="float32", device=device)
    sd.wait()
    return audio.flatten()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--say")
    ap.add_argument("--once", type=float)
    ap.add_argument("--listen", action="store_true")
    ap.add_argument("--device", type=int)
    ap.add_argument("--no-reply", action="store_true")
    args = ap.parse_args()

    if args.say:
        p = say(args.say)
        print("ok", p)
        return

    model = load_stt()
    if args.listen:
        try:
            listen_loop(model, args.device, tts_reply=not args.no_reply)
        except KeyboardInterrupt:
            log("停了")
        return

    secs = args.once or 5.0
    audio = record_once(secs, args.device)
    text = transcribe(model, audio)
    print("识别结果：" + (text or "（没听清）"))
    if text:
        append_log(text)


if __name__ == "__main__":
    main()


