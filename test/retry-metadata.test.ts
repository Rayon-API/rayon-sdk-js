import assert from 'node:assert/strict';
import {test} from 'node:test';
import {responseMetadata} from '../src/response.js';
import {RayonError} from '../src/errors.js';
test('optional retryable preserves strict boolean values and is not inferred for missing metadata',()=>{
 for (const flag of [true,false,undefined,'true',1,null]) {
  const metadata=responseMetadata(503,{},'test-key',{error:{code:'generation_unavailable',retryable:flag}});
  const error=new RayonError('http',metadata);
  assert.equal(error.retryable,typeof flag==='boolean'?flag:undefined);
 }
 assert.equal(new RayonError('timeout').retryable,undefined);
});
