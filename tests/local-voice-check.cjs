// Synthetic text -> native WAV -> local ASR. No microphone or audio playback.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {LocalVoice,execute}=require('../local-tools/lib/native.cjs');
(async()=>{
  const data=process.env.DESK_NATIVE_DATA||path.join(os.homedir(),'.codex-desk'),python=path.join(data,'tools','python','Scripts','python.exe'),voice=new LocalVoice({directory:data,python});
  const status=await voice.status();assert.ok(status.modules.vosk&&status.modules.pyautogui&&status.modules.sounddevice&&status.model);
  const audio=await voice.speech('你好，这是本地语音测试。');assert.match(audio,/^data:audio\/wav;base64,/);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'desk-offline-audio-')),file=path.join(directory,'synthetic.wav');fs.writeFileSync(file,Buffer.from(audio.split(',')[1],'base64'));
  try{
    const code="import sys,wave,json;from vosk import Model,KaldiRecognizer,SetLogLevel;SetLogLevel(-1);w=wave.open(sys.argv[1]);r=KaldiRecognizer(Model(sys.argv[2]),w.getframerate());parts=[]\nwhile True:\n b=w.readframes(4000)\n if not b:break\n if r.AcceptWaveform(b):parts.append(json.loads(r.Result()).get('text',''))\nparts.append(json.loads(r.FinalResult()).get('text',''));print(json.dumps({'text':''.join(parts),'channels':w.getnchannels(),'sampleWidth':w.getsampwidth(),'frames':w.getnframes()}))";
    const result=JSON.parse(await execute(python,['-c',code,file,path.join(data,'tools','voice','vosk-model-small-cn-0.22')],'',{timeout:60000}));assert.ok(result.text.trim());assert.equal(result.channels,1);assert.equal(result.sampleWidth,2);
    const receipt={passed:true,syntheticSpeechRecognized:result.text,audioFrames:result.frames,microphoneOpened:false,audioPlayed:false,screenCaptured:false,nativeInputSent:false,cloudAudioCalled:false};
    const output=process.env.DESK_TEST_ARTIFACTS||directory;fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'offline-voice.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
