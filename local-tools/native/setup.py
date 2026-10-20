"""Install optional local features into this application's Python and data only."""
import sys, pathlib, subprocess, urllib.request, zipfile, tempfile, json, hashlib, shutil

def setup(data):
    environment = pathlib.Path(data) / 'tools' / 'python'
    if pathlib.Path(sys.prefix).resolve() != environment.resolve():
        import venv
        if not environment.exists(): venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python3')
        if not python.is_file(): raise RuntimeError('独立Python目录不完整，请修复本地工具环境')
        subprocess.run([str(python), '-B', str(pathlib.Path(__file__).resolve()), str(pathlib.Path(data).resolve())], check=True)
        return
    packages = ['PyAutoGUI==0.9.54', 'vosk==0.3.45', 'sounddevice==0.5.3']
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', *packages], check=True)
    root = pathlib.Path(data) / 'tools' / 'voice'
    root.mkdir(parents=True, exist_ok=True)
    model = root / 'vosk-model-small-cn-0.22'
    if not (model / 'am' / 'final.mdl').is_file():
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            archive = pathlib.Path(temporary) / 'model.zip'
            with urllib.request.urlopen('https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip', timeout=60) as response, archive.open('wb') as output:
                size = 0
                while chunk := response.read(1024*1024):
                    size += len(chunk)
                    if size > 100*1024*1024: raise RuntimeError('识别模型下载超过上限')
                    output.write(chunk)
            with zipfile.ZipFile(archive) as z:
                if sum(i.file_size for i in z.infolist()) > 500*1024*1024: raise RuntimeError('模型解压超过上限')
                for member in z.infolist():
                    target = (pathlib.Path(temporary) / member.filename).resolve()
                    if not target.is_relative_to(pathlib.Path(temporary).resolve()) or member.filename.startswith(('/', '\\')) or ((member.external_attr >> 16) & 0o170000) == 0o120000:
                        raise RuntimeError('模型压缩包路径无效')
                z.extractall(temporary)
            extracted = pathlib.Path(temporary) / model.name
            if not (extracted / 'am' / 'final.mdl').is_file(): raise RuntimeError('识别模型不完整')
            if model.exists(): model.rename(root / (model.name + '.incomplete-' + next(tempfile._get_candidate_names())))
            extracted.rename(model)
            (root / 'download.json').write_text(json.dumps(dict(model=model.name, sha256=hashlib.sha256(archive.read_bytes()).hexdigest(), source='alphacephei.com')), encoding='utf-8')
    # No microphone, screenshot, input action, or sound during installation.
    subprocess.run([sys.executable, '-c', 'import vosk,sounddevice,pyautogui;print("本地电脑与语音依赖已配置")'], check=True)

if __name__ == '__main__': setup(sys.argv[1])
