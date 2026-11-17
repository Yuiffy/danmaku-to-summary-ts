import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { Response } from 'node-fetch';
import { qqRequest } from './QQPolicy';
import { qqVideoInput } from './QQVideoInputPolicy';
import { QQVideoInputs } from './QQVideoInputs';
import { createQQImageTools } from './QQImageTools';

const url='https://multimedia.nt.qq.com.cn/download?private-token';
const req=()=>qqRequest({kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',senderId:'member',groupOpenid:'group',
  messageId:'video',timestamp:new Date().toISOString(),content:'直接生成视频变岁己',attachments:[{content_type:'video/mp4',url}]},Date.now())!;
const signal=()=>new AbortController().signal;
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'qq-video-input-'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});

test('video quote selection respects explicit quote identity, MIME, URL allowlist and attachment limits',()=>{
  const video={content_type:'video/mp4',url};
  expect(qqVideoInput({msgType:103,refMsgIdx:'v',msgElements:[{msg_idx:'v',attachments:[video]}]})).toEqual({urls:[url]});
  expect(qqVideoInput({refMsgIdx:'image',msgElements:[{msg_idx:'other',attachments:[video]},
    {msg_idx:'image',attachments:[{content_type:'image/png',url}]}]})).toBeUndefined();
  expect(qqVideoInput({attachments:[{content_type:'video/mp4',url:'https://evil.invalid/video'}]})).toEqual({urls:[],invalid:true});
  expect(qqVideoInput({attachments:Array(4).fill(video)})).toMatchObject({invalid:true});
  expect(qqVideoInput({attachments:[{content_type:'text/plain',url}]})).toBeUndefined();
  expect(req().imageInput).toBeUndefined();
});
test('a current video cannot bind an unrelated recent group image as its source',async()=>{
  const load=jest.fn(), recent={read:jest.fn(),select:jest.fn()};
  const tools=createQQImageTools(req(),{characters:[]} as any,load,jest.fn(),undefined,undefined,recent);
  expect(tools.tools.map(tool=>tool.name)).not.toContain('read_recent_images');
  expect(tools.tools.map(tool=>tool.name)).not.toContain('select_recent_image');
  await tools.prepare!();expect(load).not.toHaveBeenCalled();expect(recent.read).not.toHaveBeenCalled();
});

test('downloads and probes a real MP4 without altering reference bytes',async()=>{
  const file=path.join(root,'fixture.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=256x256:rate=2:duration=2',
    '-an','-c:v','libx264','-pix_fmt','yuv420p',file],{windowsHide:true});
  const bytes=await fs.readFile(file), transport=jest.fn(async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}}));
  const inputs=new QQVideoInputs(root,'900000001',transport as any);
  const source=await inputs.load(req(),signal());
  expect(source[0].durationMs).toBe(2000);expect(await fs.readFile(source[0].file)).toEqual(bytes);
  expect(transport.mock.calls).toHaveLength(1);
});

test('rejects redirect, size, MIME, invalid bytes, dimensions and total duration before queue admission',async()=>{
  const bytes=Buffer.from('0000ftypisom0000'), probe=jest.fn(async()=>({width:256,height:256,durationMs:8000}));
  for(const response of [new Response(bytes,{status:302}),new Response(bytes,{headers:{'content-type':'text/plain'}}),
    new Response('bad',{headers:{'content-type':'video/mp4'}}),new Response(bytes,{headers:{'content-type':'video/mp4','content-length':String(50*1024*1024+1)}})]) {
    const inputs=new QQVideoInputs(root,'900000001',jest.fn(async()=>response) as any,probe);
    await expect(inputs.load(req(),signal())).rejects.toThrow('未提交');
  }
  expect(probe).not.toHaveBeenCalled();
  const input=req();input.videoInput!.urls=[url,url];
  const inputs=new QQVideoInputs(root,'900000001',jest.fn(async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})) as any,probe);
  await expect(inputs.load(input,signal())).rejects.toThrow('总时长');
  probe.mockResolvedValue({width:100,height:256,durationMs:3000});
  await expect(inputs.load(req(),signal())).rejects.toThrow('200—2160');
  const abort=new AbortController();abort.abort(new Error('cancelled'));
  await expect(inputs.load(req(),abort.signal)).rejects.toThrow('cancelled');
});
