import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const nearbyRoot = resolve(projectDirectory, '../..');
const hasLocalEntry = existsSync(resolve(projectDirectory, 'lib/index.js')) || existsSync(resolve(projectDirectory, 'src/index.ts'));
const fantasyFinalRoot = process.env.FANTASYFINAL_ROOT
  && !hasLocalEntry ? resolve(process.env.FANTASYFINAL_ROOT)
  : hasLocalEntry ? projectDirectory : nearbyRoot;
const configuredPath = process.env.FANTASYFINAL_SERVER_CONFIG
  ? resolve(process.env.FANTASYFINAL_SERVER_CONFIG)
  : resolve(projectDirectory, 'alemon.config.yaml');

if (existsSync(configuredPath)) process.env.CFG_PATH = configuredPath;
else {
  console.error(`[FantasyFinal server] 未找到配置文件：${configuredPath}`);
  console.error('[FantasyFinal server] 请复制 alemon.config.yaml.example 为 alemon.config.yaml 并填写数据库与 Redis。');
  process.exit(1);
}

// 先确定配置路径，再加载框架，避免配置单例提前读取其他目录。
process.chdir(projectDirectory);
const { start } = await import('alemonjs');
const compiledEntry = resolve(fantasyFinalRoot, 'lib/index.js');
if (!existsSync(compiledEntry)) {
  console.error(`[FantasyFinal server] 未找到编译入口：${compiledEntry}`);
  console.error('[FantasyFinal server] 请先用 lvy build 生成 lib，或从完整项目复制 lib 目录；不能直接用 node 加载 src/index.ts。');
  process.exit(1);
}
start({
  input: relative(projectDirectory, compiledEntry),
  login: 'server',
});
