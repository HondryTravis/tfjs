/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {BinaryInputs, Div, env, TensorInfo, util} from '@tensorflow/tfjs-core';
import {KernelConfig} from '@tensorflow/tfjs-core';
import {sizeFromShape} from '@tensorflow/tfjs-core/dist/util';

import {MathBackendWebGL} from '../backend_webgl';
import {BinaryOpProgram} from '../binaryop_gpu';
import {BinaryOpPackedProgram} from '../binaryop_packed_gpu';
// import {binaryKernelFunc} from '../kernel_utils/kernel_funcs_utils';

// Without the equality check div produces 0.9999 for a = b, which when
// floored can cause errors.
const DIV = `
if (a == b) {
  return 1.0;
};
return a / b;`;

// We do the same as in ./binaryop_gpu, with vec4 and ivec4.
// On Linux, the vectorized implementation produces NaNs when a and b are 0.
const DIV_PACKED = `
  // vec4 one = vec4(equal(a, b));
  // return one + (vec4(1.0) - one) * a / b;
  vec4 result = a / b;
  if(a.x == b.x) {
    result.x = 1.;
  }
  if(a.y == b.y) {
    result.y = 1.;
  }
  if(a.z == b.z) {
    result.z = 1.;
  }
  if(a.w == b.w) {
    result.w = 1.;
  }

  return result;
`;

// export const divKernelFunc = binaryKernelFunc(
//     DIV, DIV_PACKED, true /* checkOutOfBoundsForPackedProgram */);

function getDivStages(
    divisor: TensorInfo, backend: MathBackendWebGL): TensorInfo[] {
  const divisorOnCPU = backend.texData.get(divisor.dataId).texture == null;
  const divisorIsScalar = util.sizeFromShape(divisor.shape) === 1;
  if (divisorOnCPU && divisorIsScalar) {
    const divisorVal = backend.texData.get(divisor.dataId).values[0] as number;
    let max = divisorVal;
    while (max > 4) {  // TODO: replace with numerical limit
      max = Math.sqrt(max);
    }

    const stages = [max];
    while (util.sizeFromShape(stages) < divisorVal) {
      stages.push(Math.min(max, divisorVal / util.sizeFromShape(stages)));
    }

    return stages.map(val => {
      const info = backend.makeTensorInfo([], 'float32');
      const data = backend.texData.get(info.dataId);
      data.values = new Float32Array(val);
      return {shape: [], dtype: 'float32', dataId: info.dataId};
    });
  }
  return [divisor];
}

export function divKernelFunc(
    {inputs, backend}: {inputs: BinaryInputs, backend: MathBackendWebGL}) {
  const {a, b} = inputs;
  const webglBackend = backend;
  const stages = getDivStages(b, webglBackend);
  const $dtype = a.dtype;

  let result = a;
  for (let i = 0; i < stages.length; i++) {
    const divisor = stages[i];
    const program = env().getBool('WEBGL_PACK_BINARY_OPERATIONS') ?
        new BinaryOpPackedProgram(
            DIV_PACKED, a.shape, divisor.shape,
            true /* checkOutOfBoundsForPackedProgram */) :
        new BinaryOpProgram(DIV, a.shape, divisor.shape);

    const previousResult = result;
    result = webglBackend.runWebGLProgram(program, [result, divisor], $dtype);

    if (previousResult.dataId !== a.dataId) {
      webglBackend.disposeData(previousResult.dataId);
    }
  }

  return result;
}

export const divConfig: KernelConfig = {
  kernelName: Div,
  backendName: 'webgl',
  kernelFunc: divKernelFunc,
};
