"""One bounded desktop operation, JSON in/out. No clipboard, shell, or credentials."""
import sys, json, io, base64, time

def perform(a, gui=None):
    if gui is None:
        import pyautogui as gui
    gui.FAILSAFE = True
    gui.PAUSE = 0.15
    width, height = gui.size()
    action = a.get('action')
    def point(x, y):
        if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, int) or not isinstance(y, int) or not (0 <= x < width and 0 <= y < height):
            raise ValueError('坐标超出主屏范围；请重新截图')
        return x, y
    if action == 'screenshot':
        image = gui.screenshot().resize((width, height))
        output = io.BytesIO(); image.save(output, format='PNG')
        return dict(width=width, height=height, screen='primary', png=base64.b64encode(output.getvalue()).decode())
    if action in ('click', 'doubleClick', 'move', 'drag'):
        x, y = point(a.get('x'), a.get('y'))
        if action == 'drag':
            sx, sy = point(a.get('fromX'), a.get('fromY'))
            gui.moveTo(sx, sy); gui.dragTo(x, y, duration=0.5)
        elif action == 'move': gui.moveTo(x, y, duration=0.2)
        else:
            button = a.get('button', 'left')
            if button not in ('left', 'right', 'middle'): raise ValueError('无效鼠标键')
            gui.click(x, y, clicks=2 if action == 'doubleClick' else 1, interval=0.12, button=button)
    elif action == 'scroll':
        amount = a.get('amount', 0)
        if isinstance(amount, bool) or not isinstance(amount, int) or not -20 <= amount <= 20: raise ValueError('单次滚动范围为-20至20')
        gui.scroll(amount)
    elif action == 'key':
        keys = a.get('keys', [])
        if not isinstance(keys, list) or not 1 <= len(keys) <= 4 or any(k not in gui.KEYBOARD_KEYS for k in keys): raise ValueError('无效快捷键')
        gui.hotkey(*keys)
    elif action == 'type':
        text = a.get('text', '')
        if not isinstance(text, str) or not text or len(text) > 1000 or '\0' in text: raise ValueError('单次输入1至1000字')
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes
            class Mouse(ctypes.Structure):
                _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('data', wintypes.DWORD), ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('extra', ctypes.c_size_t)]
            class Keyboard(ctypes.Structure):
                _fields_ = [('vk', wintypes.WORD), ('scan', wintypes.WORD), ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('extra', ctypes.c_size_t)]
            class Union(ctypes.Union): _fields_ = [('mi', Mouse), ('ki', Keyboard)]
            class Input(ctypes.Structure): _fields_ = [('type', wintypes.DWORD), ('u', Union)]
            raw = text.encode('utf-16-le')
            for i in range(0, len(raw), 2):
                gui.failSafeCheck()
                scan = int.from_bytes(raw[i:i+2], 'little')
                events = (Input * 2)(Input(1, Union(ki=Keyboard(0, scan, 4, 0, 0))), Input(1, Union(ki=Keyboard(0, scan, 6, 0, 0))))
                if ctypes.windll.user32.SendInput(2, events, ctypes.sizeof(Input)) != 2: raise RuntimeError('系统拒绝输入；不能控制提权窗口')
        elif sys.platform == 'darwin':
            import Quartz
            for character in text:
                gui.failSafeCheck()
                for down in (True, False):
                    event = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
                    Quartz.CGEventKeyboardSetUnicodeString(event, len(character.encode('utf-16-le')) // 2, character)
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
        else: raise ValueError('仅支持 Windows / macOS')
    else: raise ValueError('不支持的电脑操作')
    return dict(ok=True, action=action, width=width, height=height)

if __name__ == '__main__':
    try: print(json.dumps(perform(json.loads(sys.stdin.readline())), ensure_ascii=False))
    except Exception as e:
        print(json.dumps(dict(error='已停止电脑操作：' + str(e)[:300]), ensure_ascii=False)); sys.exit(1)
