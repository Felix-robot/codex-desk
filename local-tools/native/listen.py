"""Streaming local ASR. Audio stays in memory; stdin pause/resume/stop."""
import sys, json, queue, threading

def emit(value): print(json.dumps(value, ensure_ascii=False), flush=True)

def listen(model_path):
    import sounddevice as sd
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
    model = Model(model_path)
    rate = int(sd.query_devices(None, 'input')['default_samplerate'])
    recognizer = KaldiRecognizer(model, rate)
    q = queue.Queue(maxsize=20)
    paused = threading.Event(); stopped = threading.Event(); reset = threading.Event()
    def commands():
        for line in sys.stdin:
            try: command = json.loads(line).get('command')
            except ValueError: continue
            if command == 'pause': paused.set(); reset.set()
            elif command == 'resume': reset.set(); paused.clear()
            elif command == 'stop': break
        stopped.set()
    threading.Thread(target=commands, daemon=True).start()
    def audio(data, frames, timing, status):
        if not stopped.is_set() and not paused.is_set():
            try: q.put_nowait(bytes(data))
            except queue.Full: pass
    # Device default rate avoids unsupported 16k input devices; Vosk accepts this rate.
    with sd.RawInputStream(samplerate=rate, blocksize=max(800, rate//5), dtype='int16', channels=1, callback=audio):
        emit(dict(type='ready'))
        last_partial = ''
        while not stopped.is_set():
            if reset.is_set():
                recognizer.Reset(); last_partial = ''
                while not q.empty():
                    try: q.get_nowait()
                    except queue.Empty: break
                reset.clear()
            try: data = q.get(timeout=0.2)
            except queue.Empty: continue
            if paused.is_set(): recognizer.Reset(); last_partial = ''; continue
            if recognizer.AcceptWaveform(data):
                text = json.loads(recognizer.Result()).get('text', '').strip()
                if text: emit(dict(type='final', text=text))
                last_partial = ''
            else:
                partial = json.loads(recognizer.PartialResult()).get('partial', '')
                if partial != last_partial:
                    emit(dict(type='partial', text=partial)); last_partial = partial

if __name__ == '__main__':
    try: listen(sys.argv[1])
    except Exception as e: emit(dict(type='error', message='麦克风或本地识别启动失败：' + str(e)[:250])); sys.exit(1)
