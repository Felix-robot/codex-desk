# Third-party notices

The repository's MIT license covers original Codex Desk code. Third-party components retain their own copyright and license terms.

## Vendored files

- **KaTeX 0.19.0** — JavaScript, CSS, and fonts in `assets/katex/`. Copyright Khan Academy and other contributors; MIT. The complete license is preserved in [`assets/katex/LICENSE`](assets/katex/LICENSE). Upstream: <https://github.com/KaTeX/KaTeX>.

## Installed dependencies

- **Codex CLI / app-server** — <https://github.com/openai/codex>, Apache-2.0. Installed from the pinned public `@openai/codex` npm package. Downloaded executables and platform helpers are excluded from Git.
- **Electron**, **@electron/packager**, **@iarna/toml**, **@xterm/xterm**, **@xterm/addon-fit**, **Marked**, and **DOMPurify** — installed with npm. See each package's bundled license and the versions in `package-lock.json`.
- Optional Python, browser, speech-recognition and desktop-operation libraries are installed separately. See `local-tools/requirements-tools.txt`, `local-tools/native/setup.py`, and the licenses distributed by those packages. The Vosk Chinese model is downloaded separately from <https://alphacephei.com/vosk/models>; it is not committed.

When distributing an application bundle containing these dependencies, include their notices and licenses. The source repository does not contain an official OpenAI desktop application, proprietary application resources, model weights, or user credentials.
