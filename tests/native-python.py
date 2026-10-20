import sys, pathlib, importlib.util, unittest, io
from PIL import Image
file = pathlib.Path(__file__).parents[1] / 'local-tools' / 'native' / 'desktop.py'
spec = importlib.util.spec_from_file_location('desktop', file); desktop = importlib.util.module_from_spec(spec); spec.loader.exec_module(desktop)
class Fake:
    KEYBOARD_KEYS=['ctrl','a','enter']
    def __init__(self): self.calls=[]
    def size(self): return (800,600)
    def screenshot(self): return Image.new('RGB',(1600,1200))
    def __getattr__(self,key): return lambda *a,**k:self.calls.append((key,a,k))
class Tests(unittest.TestCase):
    def test_retina_and_actions(self):
        import base64
        gui=Fake(); result=desktop.perform({'action':'screenshot'},gui)
        self.assertEqual(Image.open(io.BytesIO(base64.b64decode(result['png']))).size,(800,600))
        desktop.perform({'action':'click','x':30,'y':40},gui);self.assertEqual(gui.calls[0][0],'click')
        desktop.perform({'action':'key','keys':['ctrl','a']},gui);self.assertEqual(gui.calls[1][0],'hotkey')
        for a in [{'action':'click','x':800,'y':1},{'action':'scroll','amount':100},{'action':'key','keys':['__bad__']},{'action':'type','text':'x'*1001}]:
            with self.assertRaises(ValueError): desktop.perform(a,gui)
if __name__=='__main__':unittest.main()
