const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
function writeImage(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,file);fs.chmodSync(file,0o600);}
class Images {
  constructor({directory,connection,readInput,fetchImpl=fetch}){Object.assign(this,{directory,connection,readInput,fetchImpl});this.active=new Map();}
  async models(signal){
    const {baseUrl,key}=this.connection();if(!key)throw new Error('请先配置 API key');
    const response=await this.fetchImpl(baseUrl+'/models',{headers:{Authorization:'Bearer '+key},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('读取图像模型失败：HTTP '+response.status);
    let json;try{json=await response.json();}catch{throw new Error('服务商模型列表不是有效的 JSON');}if(!Array.isArray(json.data))throw new Error('服务商模型列表格式无效');return json.data.map(m=>m.id).filter(id=>typeof id==='string'&&/^gpt-image-/.test(id));
  }
  cancel(id){this.active.get(id)?.abort();}
  async generate({id,model,prompt,editPath,transparent=false}){
    if(typeof id!=='string'||id.length>100||this.active.has(id))throw new Error('生成任务编号无效');
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>20000)throw new Error('请填写图像描述，最多20000字');
    const {baseUrl,key}=this.connection(),controller=new AbortController();this.active.set(id,controller);
    const timer=setTimeout(()=>controller.abort(),180000);
    try{
      if(!(await this.models(controller.signal)).includes(model))throw new Error('此模型不在当前中转的图像模型列表中');
      const parameters={model,prompt,n:1,size:'1024x1024',quality:'low',...(transparent?{background:'transparent'}:{})};
      let body,headers={Authorization:'Bearer '+key},endpoint='/images/generations';
      if(editPath){
        const input=await this.readInput(editPath);if(input.bytes.length>20*1024*1024)throw new Error('编辑图片上限20 MB');
        body=new FormData();for(const[name,value]of Object.entries(parameters))body.append(name,String(value));body.append('image[]',new Blob([input.bytes],{type:input.mime}),path.basename(editPath));endpoint='/images/edits';
      }else{headers['Content-Type']='application/json';body=JSON.stringify(parameters);}
      const response=await this.fetchImpl(baseUrl+endpoint,{method:'POST',headers,body,signal:controller.signal});
      if(!response.ok){await response.body?.cancel();throw new Error(`图像接口返回 HTTP ${response.status}；请检查该中转是否开放 ${endpoint} 和此模型权限`);}
      if(Number(response.headers.get('content-length')||0)>40*1024*1024){await response.body?.cancel();throw new Error('图片响应过大');}
      const reader=response.body.getReader(),chunks=[];let size=0;while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>40*1024*1024){await reader.cancel();throw new Error('图片响应过大');}chunks.push(Buffer.from(value));}
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('图像接口返回了无法解析的 JSON');}const encoded=result.data?.[0]?.b64_json;
      if(typeof encoded!=='string'||encoded.length>28*1024*1024||!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded))throw new Error('中转没有返回可保存的 base64 图片，未自动下载第三方地址');
      const bytes=Buffer.from(encoded,'base64');if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('接口未返回 PNG 图片');
      if(bytes.readUInt32BE(16)*bytes.readUInt32BE(20)>40000000)throw new Error('返回图片超过4000万像素，请缩小尺寸');
      const file=path.join(this.directory,'attachments',`generated-${randomUUID()}.png`);writeImage(file,bytes);
      return{path:file,name:path.basename(file),size:bytes.length,image:true};
    }catch(e){if(controller.signal.aborted)throw new Error('图像生成已取消或超过3分钟；服务商可能已处理请求，请先检查结果再重试');throw e;}
    finally{clearTimeout(timer);this.active.delete(id);}
  }
}
module.exports={Images};
