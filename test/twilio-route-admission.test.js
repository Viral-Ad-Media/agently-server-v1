"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
test('case and trailing-slash aliases cannot bypass provider authentication',async()=>{
 const app=express();app.use(express.urlencoded({extended:false}));app.use('/api/twilio',require('../api/routes/twilio'));
 const server=app.listen(0);
 try{for(const route of ['recording-status','recording-status/','RECORDING-STATUS','call-status','voice-app','transfer-status']){
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/twilio/${route}`,{method:'POST',body:new URLSearchParams({CallSid:'synthetic'})});
  assert.equal(r.status,403,route);
 }}finally{server.close();}
});
