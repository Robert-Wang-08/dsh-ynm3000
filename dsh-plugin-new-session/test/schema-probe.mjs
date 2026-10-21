/**
 * 用 DSH 本体的 `assertSupportedJsonSchema` 校验插件声明的参数与输出 schema，
 * 确认手写定义（不 import defineTool）也能通过 registry 的注册校验。
 *
 * 仅供本地验证，不随插件分发；DSH 升级后包路径可能变化。
 * 运行：node test/schema-probe.mjs
 */
import { outputSchema, parameters } from '../index.js';

const DSH_TOOLS_JSON_SCHEMA =
	'file:///C:/Users/wwm_1/AppData/Local/nvm/v24.18.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js';

const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import(DSH_TOOLS_JSON_SCHEMA);

assertSupportedJsonSchema(parameters);
assertSupportedJsonSchema(outputSchema);
assertObjectJsonSchema(outputSchema);
console.log('ok - parameters and output schema accepted by the DSH json-schema subset');
