const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
let command = {id:'fixture',accountId:7,operation:'readSystemRules',payload:{}};
let receipt;
function load(name) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../services',name+'.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{exports,Date,require(id){
    if(id==='./writingRules') return load('writingRules');
    if(id==='./memory') return new Proxy({}, {get(){return () => {throw new Error('Read command must not access database or sync');};}});
    if(id==='react-native') return {DeviceEventEmitter:{emit(){throw new Error('Read command must not emit mutation');}}};
    if(id==='./pcHarness') return {
      getPcHarnessConfig:async()=>({accountId:7}),
      createPcHarnessClientFromConfig:()=>({nextMobileMemoryCommand:async()=>({command}), completeMobileMemoryCommand:async(_id,_account,result)=>{receipt=result;}}),
    };
    throw new Error(id);
  }});
  return exports;
}
(async()=>{
  const rules = load('writingRules');
  const commands = load('mobileMemoryCommands');
  await commands.processNextPcMemoryCommand();
  assert.equal(receipt.success,true);
  assert.equal(receipt.cacheSynced,false);
  assert.equal(receipt.systemRules.defaultExperience,rules.DEFAULT_WRITING_EXPERIENCE);
  assert.equal(receipt.systemRules.outputRules,rules.MOBILE_OUTPUT_RULES);
  assert.equal(receipt.systemRules.accountId,7);
  assert.equal(receipt.systemRules.editable,false);
  assert.ok(receipt.systemRules.version);
  command = {...command,accountId:8};
  await commands.processNextPcMemoryCommand();
  assert.equal(receipt.success,false);
  assert.equal(receipt.systemRules,undefined);
  console.log('PASS: phone live rules source/version, read-only no database/sync/event, account mismatch');
})().catch(error=>{console.error(error);process.exitCode=1;});
