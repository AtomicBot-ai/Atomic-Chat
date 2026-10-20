const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const projectRequire = require('node:module').createRequire(path.resolve(__dirname, '../web-app/package.json'))
const ts = projectRequire('typescript')
const root = path.resolve(__dirname, '../web-app/src')
const cache = new Map(), storage = new Map()
global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }
global.window = new EventTarget()
let imports = [], emitted = [], notices = [], preflights = 0, importer = async () => {}
const mocks = {
  '@janhq/core': { EngineManager: { instance: () => ({ get: () => ({ import: (...args) => { imports.push(args); return importer(...args) } }) }) }, events: { emit: (...args) => emitted.push(args) }, DownloadEvent: { onFileDownloadError: 'error', onFileDownloadStopped: 'stopped' } },
  '@/lib/utils': { LOCAL_LLAMACPP_PROVIDER: 'llamacpp-upstream', formatBytes: String },
  '@/lib/telemetry': { markDownloadStart() {}, normalizeModelId: x=>x, quantFromModelId: ()=>'', sizeBucket: ()=>'', isHfUrl: ()=>true, urlHost: ()=>'' },
  '@/lib/telemetry-queue': { queuedCapture() {} },
  '@/i18n/setup': { __esModule: true, default: { t: x=>x } },
  'sonner': { toast: { info: x=>notices.push(x), error: x=>notices.push(x) } },
  '@/services/models/downloadPreflight': { preflightDownloadDiskSpace: async ()=> { preflights++; return undefined } },
}
for (const [file, method] of [
 ['@/services/diffusion/engine','isDiffusionEngineTaskId'],
 ['@/services/engine-builds/install','isEngineBuildTaskId'],
 ['@/services/engines/update','isEngineUpdateTaskId'],
 ['@/lib/diffusion/models','isDiffusionModelDownloadTaskId'],
 ['@/lib/decision/models','isDecisionDownloadTaskId'],
 ['@/lib/embedding/models','isEmbeddingDownloadTaskId'],
 ['@/lib/managed-engine/download-id','isManagedDownloadId'],
 ['@/lib/foundry-local/download-id','isFoundryLocalDownloadId'],
]) mocks[file] = { [method]: () => false }
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const mod = { exports: {} }; cache.set(file, mod)
  const source = fs.readFileSync(file, 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: file, reportDiagnostics: true })
  assert.equal(result.diagnostics.filter(x=>x.category===ts.DiagnosticCategory.Error).length, 0)
  const req = spec => {
    if (mocks[spec]) return mocks[spec]
    let resolved
    if (spec.startsWith('@/')) resolved = path.join(root, spec.slice(2))
    else if (spec.startsWith('.')) resolved = path.resolve(path.dirname(file), spec)
    else if (['zustand','zustand/middleware'].includes(spec)) return projectRequire(spec)
    else return {}
    const relative = '@/'+path.relative(root,resolved).replaceAll(path.sep,'/')
    if (mocks[relative]) return mocks[relative]
    if (!/\.(ts|tsx)$/.test(resolved)) resolved += '.ts'
    if (!fs.existsSync(resolved)) return {}
    // The service's unrelated features are outside these tests; use inert dependencies.
    if (!['useDownloadStore.ts','downloadRecovery.ts','downloadFormat.ts','default.ts','downloadCancellation.ts'].includes(path.basename(resolved))) return {}
    return load(resolved)
  }
  vm.runInThisContext('(function(require,module,exports){'+result.outputText+'\n})', {filename:file})(req,mod,mod.exports)
  return mod.exports
}
const { modelDownloadKey, saveDownloadRecovery, restoreDownloadRecovery } = load(path.join(root,'lib/downloadRecovery.ts'))
const { useDownloadStore: store } = load(path.join(root,'hooks/useDownloadStore.ts'))
const { DefaultModelsService, withStoppedModelDownload } = load(path.join(root,'services/models/default.ts'))
const { scanLegacyModelDownloads, mergeLegacyModelDownloads, beginLegacyDownloadRecovery } = load(path.join(root,'services/models/downloadRecovery.ts'))
const { cancelDownload } = load(path.join(root,'lib/downloadCancellation.ts'))
const modelPath = 'https://huggingface.co/acme/model/resolve/main/model-Q4-00001-of-00002.gguf'
const params = {modelPath, provider:'llamacpp-upstream', hfToken:'hf_secret_test', skipVerification:true}
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log('PASS '+name) }
function reset() { store.setState({ downloads:{}, dismissedDownloads:new Set(), resumeParams:{}, localDownloadingModels:new Set(), pausedDownloads:new Set(), resumableDownloads:new Set(), downloadOriginByModelId:{}, downloadRequestOriginByModelId:{} }); imports=[]; emitted=[]; notices=[]; preflights=0; importer=async()=>{} }
const tick = () => new Promise(r=>setImmediate(r))
;(async()=>{
await check('file disposal waits for stop and importer, blocks retries, and releases its claim on failure', async()=>{
 reset()
 const service = new DefaultModelsService()
 let releaseImport, releaseStop
 importer = () => new Promise(r=> { releaseImport=r })
 const running = service.pullModelWithMetadata('acme/disposal',modelPath,undefined,undefined,true,params)
 await tick()
 assert.equal(imports.length,1)
 let disposed=false
 const operation = withStoppedModelDownload('acme/disposal',()=>new Promise(r=>{releaseStop=r}),async()=>{disposed=true; throw Error('trash failed')})
 const failure = assert.rejects(operation,/trash failed/)
 await service.pullModelWithMetadata('acme/disposal',modelPath,undefined,undefined,true,params)
 assert.equal(imports.length,1)
 releaseStop(); await tick(); assert.equal(disposed,false)
 releaseImport(); await running; await failure
 assert.equal(disposed,true)
 importer=async()=>{}
 await service.pullModelWithMetadata('acme/disposal',modelPath,undefined,undefined,true,params)
 assert.equal(imports.length,2)
})
await check('identity groups GGUF shards but separates repo, revision and quant', ()=>{
 assert.equal(modelDownloadKey(params),modelDownloadKey({...params,modelPath:modelPath.replace('00001','00002')}))
 for(const changed of [modelPath.replace('/acme/','/other/'),modelPath.replace('/main/','/v2/'),modelPath.replace('Q4','Q8')]) assert.notEqual(modelDownloadKey(params),modelDownloadKey({...params,modelPath:changed}))
})
await check('restart restores paused rows, counters and resume options without credentials or reply intent', async()=>{
 reset(); store.getState().setResumeParams('model',params); store.getState().setDownloadOrigin('model','acme/model','reply-gate'); store.getState().updateProgress('model',.4,'model',40,100)
 const saved=storage.get('atomic-model-downloads-v1'); assert(!saved.includes('hf_secret_test'))
 store.setState({downloads:{},resumeParams:{},pausedDownloads:new Set(),localDownloadingModels:new Set()})
 storage.set('atomic-model-downloads-v1',saved); await store.persist.rehydrate()
 const s=store.getState(); assert(s.pausedDownloads.has('model')); assert.equal(s.downloads.model.current,40); assert.equal(s.downloads.model.speed.bytesPerSecond,0); assert.equal(s.resumeParams.model.provider,'llamacpp-upstream'); assert.equal(s.downloadRequestOriginByModelId.model,'standalone'); assert.equal(imports.length,0)
})
await check('unsafe signed URLs and malformed recovery entries are ignored',()=>{
 reset(); store.getState().setResumeParams('signed',{...params,modelPath:modelPath+'?token=secret'}); assert.equal(saveDownloadRecovery(store.getState()).entries.length,0)
 for (const invalid of [null,{}, {entries:[null,{}, {id:'../escape',params}, {id:'bad',params:{modelPath:'file:///tmp/model'}}]}]) assert.equal(Object.keys(restoreDownloadRecovery(invalid).resumeParams).length,0)
})
await check('duplicate durable aliases restore only one row',()=>{
 const r=restoreDownloadRecovery({entries:[{id:'first',params,current:40,total:100},{id:'alias',params,current:0,total:100}]}); assert.deepEqual(Object.keys(r.downloads),['first'])
})
await check('simultaneous requests across service instances start one import before asynchronous probes',async()=>{
 reset(); let finish; importer=()=>new Promise(r=>finish=r)
 const a=new DefaultModelsService(),b=new DefaultModelsService()
 const first=a.pullModelWithMetadata('model',modelPath,undefined,undefined,true,false)
 const second=b.pullModelWithMetadata('alias',modelPath,undefined,undefined,true,false)
 await tick(); assert.equal(imports.length,1); assert.equal(preflights,1); assert(notices.includes('common:downloadAlreadyActive')); finish(); await Promise.all([first,second])
})
await check('restart plus another model alias resumes the original id and reopens the panel',async()=>{
 reset(); store.getState().setResumeParams('original',params); store.getState().markPausedDownload('original'); store.getState().addLocalDownloadingModel('alias')
 let opened=0; const onOpen=()=>opened++; window.addEventListener('atomic-open-download-panel',onOpen)
 await new DefaultModelsService().pullModelWithMetadata('alias',modelPath)
 window.removeEventListener('atomic-open-download-panel',onOpen)
 assert.equal(imports.length,1); assert.equal(imports[0][0],'original'); assert.equal(imports[0][1].resume,true); assert(!store.getState().localDownloadingModels.has('alias')); assert(opened>0)
})
await check('a different revision with the same destination cannot replace the original request',async()=>{
 reset(); store.getState().setResumeParams('model',params)
 await new DefaultModelsService().pullModelWithMetadata('model',modelPath.replace('/main/','/v2/'))
 assert.equal(imports.length,0); assert.equal(store.getState().resumeParams.model.modelPath,modelPath); assert(notices.includes('common:downloadDestinationBusy'))
})
await check('MLX import retains every companion and the engine provider',async()=>{
 reset(); const files=[{url:'https://huggingface.co/acme/mlx/resolve/main/config.json',filename:'config.json'}]
 await new DefaultModelsService().pullModelWithMetadata('mlx-model','https://huggingface.co/acme/mlx/resolve/main/model.safetensors',undefined,undefined,true,false,{provider:'mlx',files})
 assert.deepEqual(imports[0][1].files,files); assert.equal(store.getState().resumeParams['mlx-model'].provider,'mlx')
})
await check('Cancel hides the job while retaining only its source mapping for an explicit retry',()=>{
 reset(); store.getState().setResumeParams('model',params); store.getState().updateProgress('model',.4,'model',40,100)
 let aborted=0; cancelDownload({id:'model',name:'model'},{models:()=>({abortDownload:()=>{aborted++;return Promise.resolve()}})})
 assert.equal(aborted,1); assert(!store.getState().pausedDownloads.has('model')); assert(store.getState().resumeParams.model); assert(!store.getState().downloads.model); assert(store.getState().dismissedDownloads.has('model'))
 store.getState().clearResumeParams('model'); assert.equal(JSON.parse(storage.get('atomic-model-downloads-v1')).state.recovery.entries.length,0)
})
await check('Cancel persists across restart and legacy scanning, while an explicit alias retry reuses the original destination',async()=>{
 reset();store.getState().setResumeParams('original',params);store.getState().updateProgress('original',.4,'original',40,100)
 cancelDownload({id:'original',name:'original'},{models:()=>({abortDownload:async()=>{}})})
 const saved=storage.get('atomic-model-downloads-v1');assert(!saved.includes('hf_secret_test'))
 store.setState({downloads:{},resumeParams:{},dismissedDownloads:new Set()});storage.set('atomic-model-downloads-v1',saved);await store.persist.rehydrate()
 assert(store.getState().dismissedDownloads.has('original'));assert(!store.getState().downloads.original)
 mergeLegacyModelDownloads({truncated:false,candidates:[{id:'original',params,current:40,total:100}]})
 assert(!store.getState().downloads.original);assert.equal(imports.length,0)
 await new DefaultModelsService().pullModelWithMetadata('alias',modelPath)
 assert.equal(imports.length,1);assert.equal(imports[0][0],'original');assert.equal(imports[0][1].resume,true);assert(!store.getState().dismissedDownloads.has('original'))
})
await check('Cancel during preflight prevents an import from starting after the row disappeared',async()=>{
 reset();let release;const gate=new Promise(r=>release=r)
 const original=mocks['@/services/models/downloadPreflight'].preflightDownloadDiskSpace
 mocks['@/services/models/downloadPreflight'].preflightDownloadDiskSpace=async()=>{await gate;return undefined}
 const request=new DefaultModelsService().pullModelWithMetadata('early',modelPath);await tick()
 cancelDownload({id:'early',name:'early'},{models:()=>({abortDownload:async()=>{}})})
 release();await request;mocks['@/services/models/downloadPreflight'].preflightDownloadDiskSpace=original
 assert.equal(imports.length,0);assert(!store.getState().downloads.early);assert(store.getState().dismissedDownloads.has('early'))
})
await check('an immediate explicit retry waits for both the canceled import and its stop notification',async()=>{
 reset();let finishImport,finishAbort;const importGate=new Promise(r=>finishImport=r),abortGate=new Promise(r=>finishAbort=r)
 const factory=mocks['@janhq/core'].EngineManager.instance
 mocks['@janhq/core'].EngineManager.instance=()=>({get:()=>({import:(...args)=>{imports.push(args);return importer(...args)},abortImport:()=>abortGate})})
 importer=()=>importGate
 const service=new DefaultModelsService(),first=service.pullModelWithMetadata('racing',modelPath);await tick()
 cancelDownload({id:'racing',name:'racing'},{models:()=>service})
 const retry=service.pullModelWithMetadata('alias',modelPath);await tick();assert.equal(imports.length,1)
 importer=async()=>{};finishImport();await tick();assert.equal(imports.length,1);assert(!store.getState().downloads.racing)
 finishAbort();await Promise.all([first,retry]);assert.equal(imports.length,2);assert.equal(imports[1][0],'racing');assert.equal(imports[1][1].resume,true);assert(!store.getState().dismissedDownloads.has('racing'))
 mocks['@janhq/core'].EngineManager.instance=factory
})
await check('unavailable local storage cannot interrupt a transfer',()=>{
 reset(); const previous=global.localStorage
 global.localStorage={getItem(){throw Error('unavailable')},setItem(){throw Error('quota')},removeItem(){throw Error('unavailable')}}
 assert.doesNotThrow(()=>store.getState().setResumeParams('model',params))
 assert.doesNotThrow(()=>store.getState().updateProgress('model',.5,'model',50,100))
 global.localStorage=previous
})
await check('MLX repository identity is independent of primary file and companion ordering',()=>{
 const one={provider:'mlx',modelPath:'https://huggingface.co/acme/mlx/resolve/main/model-00001.safetensors'}
 assert.equal(modelDownloadKey(one),modelDownloadKey({...one,modelPath:one.modelPath.replace('00001','00002')}))
 assert.notEqual(modelDownloadKey(one),modelDownloadKey({...one,modelPath:one.modelPath.replace('/main/','/v2/')}))
})
await check('a first request safely enables the existing Rust partial-file validation',async()=>{
 reset(); await new DefaultModelsService().pullModelWithMetadata('model',modelPath)
 assert.equal(imports[0][1].resume,true); assert.equal(preflights,1)
})
await check('rapid pause/resume waits for the predecessor import to settle',async()=>{
 reset(); let finish; importer=()=>new Promise(r=>finish=r)
 const service=new DefaultModelsService(); const first=service.pullModelWithMetadata('model',modelPath); await tick()
 store.getState().markPausedDownload('model'); const resume=service.pullModelWithMetadata('model',modelPath,undefined,undefined,true,true); await tick(); assert.equal(imports.length,1)
 importer=async()=>{}; finish(); await Promise.all([first,resume]); assert.equal(imports.length,2); assert.equal(imports[1][1].resume,true)
})
const fsp=require('node:fs/promises'), crypto=require('node:crypto'), os=require('node:os')
const fixtures=[]
async function fixture(records) {
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'atomic-recovery-fixture-'))
 for(const [relative,body] of Object.entries(records)){ const target=path.join(directory,relative); await fsp.mkdir(path.dirname(target),{recursive:true}); await fsp.writeFile(target,body) }
 const read=[]
 const io={list:async p=>(await fsp.readdir(p)).map(n=>path.join(p,n)),stat:async p=>{try{const s=await fsp.stat(p);return {isDirectory:s.isDirectory(),size:s.size}}catch{return null}},readText:async p=>{assert(/\.(url|parts)$/.test(p),'Scanner may read sidecars only');read.push(p);return fsp.readFile(p,'utf8')}}
 const hash=async()=>{const result={};const walk=async(folder)=>{for(const name of (await fsp.readdir(folder)).sort()){const file=path.join(folder,name);if((await fsp.stat(file)).isDirectory())await walk(file);else result[path.relative(directory,file)]=crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex')}};await walk(directory);return result}
 const before=await hash();fixtures.push(async()=>assert.deepEqual(await hash(),before))
 return {directory,io,read}
}
const legacyUrl='https://huggingface.co/acme/legacy/resolve/v7/model-Q4.gguf'
await check('legacy single-stream sidecars create a resumable job without a saved journal',async()=>{
 reset();const f=await fixture({'llamacpp/models/old/model.gguf.tmp':Buffer.alloc(40,7),'llamacpp/models/old/model.gguf.url':legacyUrl})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/llamacpp/models',provider:'llamacpp-upstream'}])
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].current,40);assert.equal(result.candidates[0].params.modelPath,legacyUrl)
 mergeLegacyModelDownloads(result);assert(store.getState().pausedDownloads.has('old'));assert.equal(store.getState().resumeParams.old.modelPath,legacyUrl);assert.equal(imports.length,0);assert.equal(f.read.length,1)
})
await check('legacy segmented progress uses received ranges rather than preallocated length',async()=>{
 reset();const map={version:1,url:legacyUrl,size:100,segments:[[0,20,50],[50,60,100]]}
 const f=await fixture({'models/old/model.gguf.tmp':Buffer.alloc(100),'models/old/model.gguf.url':legacyUrl,'models/old/model.gguf.parts':JSON.stringify(map)})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'llamacpp-upstream'}]);assert.equal(result.candidates[0].current,30);assert.equal(result.candidates[0].total,100);assert(!result.candidates[0].blocked)
})
await check('a valid legacy segment map reconstructs the source even when its URL marker is missing',async()=>{
 reset();const map={version:1,url:legacyUrl,size:100,segments:[[50,60,100],[0,20,50]]}
 const f=await fixture({'models/parts-only/model.gguf.tmp':Buffer.alloc(100),'models/parts-only/model.gguf.parts':JSON.stringify(map)})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'llamacpp-upstream'}]);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].params.modelPath,legacyUrl);assert.equal(result.candidates[0].current,30);assert(!result.candidates[0].blocked);mergeLegacyModelDownloads(result);assert(store.getState().pausedDownloads.has('parts-only'))
})
await check('legacy GGUF shards and projector become one request',async()=>{
 reset();const first='https://huggingface.co/acme/legacy/resolve/main/model-Q4-00001-of-00002.gguf'
 const f=await fixture({'models/sharded/model-Q4-00001-of-00002.gguf.tmp':Buffer.alloc(20),'models/sharded/model-Q4-00001-of-00002.gguf.url':first,'models/sharded/model-Q4-00002-of-00002.gguf.tmp':Buffer.alloc(10),'models/sharded/model-Q4-00002-of-00002.gguf.url':first.replace('00001','00002'),'models/sharded/mmproj.gguf.tmp':Buffer.alloc(5),'models/sharded/mmproj.gguf.url':'https://huggingface.co/acme/legacy/resolve/main/mmproj.gguf'})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'llamacpp-upstream'}]);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].current,35);assert(result.candidates[0].params.mmprojPath.endsWith('/mmproj.gguf'));mergeLegacyModelDownloads(result);assert.equal(Object.keys(store.getState().downloads).length,1)
})
await check('missing and corrupt legacy metadata remain visible but cannot start a transfer',async()=>{
 reset();const f=await fixture({'models/orphan/model.gguf.tmp':Buffer.alloc(10),'models/corrupt/model.gguf.tmp':Buffer.alloc(100),'models/corrupt/model.gguf.url':legacyUrl,'models/corrupt/model.gguf.parts':'{invalid'})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'llamacpp-upstream'}]);assert.equal(result.candidates.length,2);assert(result.candidates.every(c=>c.blocked&&!c.params));mergeLegacyModelDownloads(result)
 assert.equal(Object.keys(store.getState().downloads).length,2);const refusal=await new DefaultModelsService().pullModelWithMetadata('orphan',legacyUrl);assert.equal(refusal.kind,'recovery_required');assert.equal(imports.length,0)
})
await check('legacy MLX reconstruction preserves nested filenames and waits for explicit resume to fetch metadata',async()=>{
 reset();const f=await fixture({'models/owner/model/weights/model.safetensors.tmp':Buffer.alloc(10),'models/owner/model/weights/model.safetensors.url':'https://huggingface.co/acme/mlx/resolve/v7/weights/model.safetensors','models/owner/model/config.json.url':'https://huggingface.co/acme/mlx/resolve/v7/config.json'})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'mlx'}]);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].id,'owner/model');assert(result.candidates[0].params.recoverRepository);mergeLegacyModelDownloads(result);assert.equal(imports.length,0)
 const service=new DefaultModelsService();let query
 service.fetchExactHuggingFaceRepo=async repo=>{query=repo;return {siblings:[{rfilename:'weights/model.safetensors'},{rfilename:'config.json'},{rfilename:'tokenizer.json'}]}}
 await service.pullModelWithMetadata('owner/model',store.getState().resumeParams['owner/model'].modelPath,undefined,undefined,true,true,store.getState().resumeParams['owner/model'])
 assert.equal(query,'acme/mlx/revision/v7');assert.equal(imports.length,1);assert.equal(imports[0][1].files.length,2);assert(imports[0][1].modelPath.includes('/resolve/v7/weights/model.safetensors'));assert.equal(store.getState().resumeParams['owner/model'].recoverRepository,false)
})
await check('existing installed model plus stale partial is displayed for review without re-importing',async()=>{
 reset();const f=await fixture({'models/installed/model.gguf.tmp':Buffer.alloc(10),'models/installed/model.gguf.url':legacyUrl,'models/installed/model.yml':'id: installed\n'})
 const result=await scanLegacyModelDownloads(f.io,[{path:f.directory+'/models',provider:'llamacpp-upstream'}]);assert.equal(result.candidates[0].blocked,'installed_model');assert(!result.candidates[0].params);mergeLegacyModelDownloads(result);assert(store.getState().downloads.installed.recoveryBlocked)
})
await check('startup migration finishes before a repeat download and does not duplicate jobs',async()=>{
 reset();const f=await fixture({'llamacpp/models/original/model.gguf.tmp':Buffer.alloc(30),'llamacpp/models/original/model.gguf.url':legacyUrl})
 let release;const gate=new Promise(r=>release=r)
 const hub={app:()=>({getJanDataFolder:async()=>{await gate;return f.directory}}),core:()=>({invoke:async(command,arg)=>command==='readdir_sync'?f.io.list(arg.args[0]):command==='file_stat'?f.io.stat(arg.args):command==='read_file_sync'?f.io.readText(arg.args[0]):assert.fail('Unexpected command')})}
 const migrating=beginLegacyDownloadRecovery(hub);assert.equal(beginLegacyDownloadRecovery(hub),migrating)
 const download=new DefaultModelsService().pullModelWithMetadata('alias',legacyUrl);await tick();assert.equal(imports.length,0);release();await migrating;await download
 assert.equal(imports.length,1);assert.equal(imports[0][0],'original');assert.equal(imports[0][1].resume,true);assert.equal(Object.keys(store.getState().resumeParams).length,1)
})
await check('startup removes only stale journal descriptions for a finished model',async()=>{
 reset();store.getState().setResumeParams('finished',{...params,modelPath:legacyUrl});store.getState().markPausedDownload('finished');store.getState().updateProgress('finished',1,'finished',100,100)
 const f=await fixture({'llamacpp/models/finished/model.gguf':Buffer.alloc(100,1),'llamacpp/models/finished/model.yml':'id: finished\n'})
 const hub={app:()=>({getJanDataFolder:async()=>f.directory}),core:()=>({invoke:async(command,arg)=>command==='readdir_sync'?f.io.list(arg.args[0]):command==='file_stat'?f.io.stat(arg.args):command==='read_file_sync'?f.io.readText(arg.args[0]):assert.fail('Unexpected command')})}
 await beginLegacyDownloadRecovery(hub);assert(!store.getState().resumeParams.finished);assert(!store.getState().downloads.finished);assert.equal(imports.length,0)
})
await check('legacy discovery never replaces a live download or creates a canonical alias',()=>{
 reset();store.getState().setResumeParams('live',params);store.getState().addLocalDownloadingModel('live');store.getState().updateProgress('live',.7,'live',70,100)
 mergeLegacyModelDownloads({truncated:false,candidates:[{id:'live',params,current:20,total:100},{id:'alias',params,current:20,total:100}]})
 assert.equal(store.getState().downloads.live.current,70);assert(!store.getState().downloads.alias)
})
await check('all legacy fixture payloads and sidecars retain identical hashes',async()=>{
 for(const verify of fixtures) await verify()
})

console.log(`RESULT ${passed} behavioral checks passed; transports, IPC, telemetry and unrelated services were mocked; only temporary model fixtures accessed; no user model files accessed.`)
})().catch(e=>{console.error(e);process.exitCode=1})
