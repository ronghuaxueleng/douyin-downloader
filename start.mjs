#!/usr/bin/env node
/**
 * douyin-downloader 启动器
 * 自动创建 .venv，使用 uv 管理依赖
 *
 * 用法: node start.mjs
 */

import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, copyFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { totalmem, freemem } from 'os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

// ── 颜色工具 ──────────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};
const green  = s => `${c.green}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;
const gray   = s => `${c.gray}${s}${c.reset}`;
const bold   = s => `${c.bold}${s}${c.reset}`;

// ── Python 路径解析 ────────────────────────────────────────────────────────────
function findPython() {
  const candidates = IS_WIN
    ? ['.venv\\Scripts\\python.exe', '.venv\\Scripts\\python3.exe']
    : ['.venv/bin/python', '.venv/bin/python3'];

  for (const rel of candidates) {
    const full = join(ROOT, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

// ── 进程管理 ───────────────────────────────────────────────────────────────────
const procs = new Map();

function launch(label, python, args, extraEnv = {}) {
  if (procs.has(label)) {
    console.log(yellow(`⚠  ${label} 已在运行，跳过`));
    return;
  }

  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ...extraEnv };
  const p = spawn(python, args, { cwd: ROOT, env, stdio: ['inherit', 'inherit', 'inherit'] });

  procs.set(label, p);

  p.on('close', code => {
    procs.delete(label);
    if (code !== 0) console.log(`${cyan(`[${label}]`)} ${gray(`退出码 ${code}`)}`);
  });
}

function stopAll() {
  if (procs.size === 0) return;
  for (const [label, p] of procs) {
    console.log(`  停止 ${label}...`);
    try { p.kill(IS_WIN ? 'SIGKILL' : 'SIGTERM'); } catch (_) {}
  }
  procs.clear();
}

// ── 环境检测 ───────────────────────────────────────────────────────────────────
function execQuiet(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', shell: IS_WIN, timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function printSysInfo(python) {
  console.log(bold('── 本机环境 ──────────────────────────────────────'));

  const pyVer = execQuiet(python, ['--version']);
  console.log(`  Python  ${pyVer ? green(pyVer.replace('Python ', '')) : gray('未知')}`);

  const totalGb = (totalmem() / 1024 ** 3).toFixed(1);
  const freeGb  = (freemem()  / 1024 ** 3).toFixed(1);
  console.log(`  内存    ${green(freeGb + ' GB')} 可用 / ${totalGb} GB 总计`);

  const configExists = existsSync(join(ROOT, 'config.yml'));
  console.log(`  配置    ${configExists ? green('config.yml 已存在') : yellow('config.yml 不存在（将使用默认配置）')}`);

  console.log(bold('──────────────────────────────────────────────────\n'));
}

// ── 依赖安装 ───────────────────────────────────────────────────────────────────
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { env: extraEnv, ...restOpts } = opts;
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WIN,
      env: { ...process.env, UV_LINK_MODE: 'copy', ...extraEnv },
      ...restOpts,
    });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} 失败（退出码 ${code}）`)));
    p.on('error', err => reject(new Error(`无法执行 ${cmd}：${err.message}`)));
  });
}

async function setupVenv() {
  console.log(yellow('⚙  未找到 .venv，正在创建虚拟环境...'));
  await runCmd('uv', ['venv', '.venv']);

  console.log(gray('\n正在安装依赖（requirements.txt）...\n'));
  await runCmd('uv', ['pip', 'install', '--python', '.venv', '-r', 'requirements.txt']);

  console.log(green('✓') + ' 依赖安装完成\n');
}

// ── Playwright 安装检查 ────────────────────────────────────────────────────────
async function ensurePlaywright(python) {
  // 1. 检查 playwright 包是否安装
  const check = spawnSync(python, ['-c', 'import playwright'], { encoding: 'utf-8' });
  if (check.status !== 0) {
    console.log(yellow('⚙  未检测到 Playwright，正在自动安装...\n'));
    await runCmd('uv', ['pip', 'install', '--python', '.venv', 'playwright']);
    console.log('');
  }

  // 2. 用 Python 读取 browsers.json，检查 Chromium 是否已安装并获取下载 URL
  console.log(gray('检查 Chromium 浏览器...'));
  const pyInfo = `
import json, os, sys, platform
import playwright as _pw
d = os.path.dirname(_pw.__file__)
bj = os.path.join(d, 'driver', 'package', 'browsers.json')
data = json.load(open(bj))
cr = next(b for b in data['browsers'] if b['name'] == 'chromium')
rev = str(cr['revision'])
bv = cr.get('browserVersion', '')
pw_path = os.environ.get('PLAYWRIGHT_BROWSERS_PATH')
if pw_path:
    cache = pw_path
elif sys.platform == 'win32':
    local = os.environ.get('LOCALAPPDATA', '')
    cache = os.path.join(local, 'ms-playwright') if local else os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'ms-playwright')
else:
    cache = os.path.expanduser('~/.cache/ms-playwright')
target = os.path.join(cache, 'chromium-' + rev)
if os.path.isdir(target):
    print('INSTALLED')
else:
    if sys.platform == 'win32':
        url = 'https://storage.googleapis.com/chrome-for-testing-public/' + bv + '/win64/chrome-win64.zip'
    elif sys.platform == 'darwin':
        arch = 'arm64' if platform.machine() == 'arm64' else 'x64'
        url = 'https://storage.googleapis.com/chrome-for-testing-public/' + bv + '/mac-' + arch + '/chrome-mac-' + arch + '.zip'
    elif platform.machine() in ('aarch64', 'arm64'):
        url = 'https://playwright.azureedge.net/builds/chromium/' + rev + '/chromium-linux-arm64.zip'
    else:
        url = 'https://storage.googleapis.com/chrome-for-testing-public/' + bv + '/linux64/chrome-linux64.zip'
    print('DOWNLOAD|' + url + '|' + target)
`.trim();

  const tmpInfoPy = join(ROOT, '.chromium-info.py');
  writeFileSync(tmpInfoPy, pyInfo, 'utf-8');
  const infoResult = spawnSync(python, [tmpInfoPy], { shell: false, encoding: 'utf-8' });
  try { unlinkSync(tmpInfoPy); } catch (_) {}
  if (infoResult.status !== 0) {
    throw new Error('获取 Chromium 版本信息失败：' + infoResult.stderr.trim());
  }

  const line = infoResult.stdout.trim();
  if (line === 'INSTALLED') {
    console.log(green('✓') + ' Chromium 已安装\n');
    return;
  }
  if (!line.startsWith('DOWNLOAD|')) {
    throw new Error('意外输出：' + line);
  }

  const [, url, targetDir] = line.split('|');

  // 3. Python 原生 SOCKS5 + SSL 下载（绕过 WinSSL/SChannel 的 close_notify 问题）
  const tmpZip = join(ROOT, '.chromium-tmp.zip');
  console.log('');
  console.log(yellow('⚙  下载 Chromium（通过 SOCKS5 代理 127.0.0.1:1080）...'));
  console.log(gray('   ' + url));
  console.log('');

  // Python 用 OpenSSL（非 WinSSL），直接建立 SOCKS5 隧道再套 SSL，url 和 out 通过 sys.argv 传入
  const pyDownload = [
    'import socket,ssl,struct,sys',
    'def c5(ph,pp,dh,dp):',
    '  s=socket.socket();s.settimeout(30);s.connect((ph,pp))',
    '  s.sendall(bytes([5,1,0]));r=s.recv(2)',
    '  if r[1]!=0:raise RuntimeError("SOCKS5 auth rejected")',
    '  h=dh.encode();s.sendall(bytes([5,1,0,3,len(h)])+h+struct.pack(">H",dp))',
    '  r=s.recv(256)',
    '  if r[1]!=0:raise RuntimeError("SOCKS5 connect failed:"+str(r[1]))',
    '  s.settimeout(120);return s',
    'url=sys.argv[1];out=sys.argv[2]',
    'parts=url.split("/");h=parts[2];p="/"+"/".join(parts[3:])',
    'sock=c5("127.0.0.1",1080,h,443)',
    'ctx=ssl.create_default_context()',
    'ss=ctx.wrap_socket(sock,server_hostname=h)',
    'req="GET "+p+" HTTP/1.1\\r\\nHost: "+h+"\\r\\nUser-Agent: python/3\\r\\nConnection: close\\r\\n\\r\\n"',
    'ss.sendall(req.encode())',
    'buf=b""',
    'while b"\\r\\n\\r\\n" not in buf:buf+=ss.recv(4096)',
    'hi=buf.index(b"\\r\\n\\r\\n")',
    'hdr=buf[:hi].decode();body=buf[hi+4:]',
    'st=int(hdr.split("\\r\\n")[0].split()[1])',
    'if st!=200:raise RuntimeError("HTTP "+str(st)+": "+hdr.split("\\r\\n")[0])',
    'cl=0',
    'for l in hdr.split("\\r\\n"):',
    '  if l.lower().startswith("content-length:"):cl=int(l.split(":",1)[1].strip())',
    'f=open(out,"wb")',
    'f.write(body);done=len(body)',
    'while True:',
    '  try:chunk=ss.recv(65536)',
    '  except:break',
    '  if not chunk:break',
    '  f.write(chunk);done+=len(chunk)',
    '  if cl:sys.stdout.write("\\r  "+str(done*100//cl)+"%  "+str(done//1048576)+"/"+str(cl//1048576)+" MB   ");sys.stdout.flush()',
    'f.close();ss.close();sys.stdout.write("\\n")',
  ].join('\n');

  await new Promise((resolve, reject) => {
    const tmpPy = join(ROOT, '.dl-chromium.py');
    writeFileSync(tmpPy, pyDownload, 'utf-8');
    const p = spawn(python, [tmpPy, url, tmpZip], {
      cwd: ROOT,
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    p.on('close', code => {
      try { unlinkSync(tmpPy); } catch (_) {}
      code === 0 ? resolve() : reject(new Error('Python 下载失败（退出码 ' + code + '）'));
    });
    p.on('error', err => {
      try { unlinkSync(tmpPy); } catch (_) {}
      reject(new Error('无法启动 Python：' + err.message));
    });
  });

  // 4. Python 解压并赋予可执行权限（Unix only）
  console.log(gray('\n正在解压...'));
  const pyExtract = `
import zipfile, os, stat, sys
zip_path = ${JSON.stringify(tmpZip)}
target = ${JSON.stringify(targetDir)}
os.makedirs(target, exist_ok=True)
with zipfile.ZipFile(zip_path) as z:
    z.extractall(target)
os.remove(zip_path)
if sys.platform != 'win32':
    for root, dirs, files in os.walk(target):
        for f in files:
            fp = os.path.join(root, f)
            st = os.stat(fp)
            os.chmod(fp, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
`.trim();

  const tmpExtractPy = join(ROOT, '.extract-chromium.py');
  writeFileSync(tmpExtractPy, pyExtract, 'utf-8');
  const extractResult = spawnSync(python, [tmpExtractPy], { shell: false, encoding: 'utf-8' });
  try { unlinkSync(tmpExtractPy); } catch (_) {}
  if (extractResult.status !== 0) {
    throw new Error('解压 Chromium 失败：' + extractResult.stderr.trim());
  }

  console.log(green('✓') + ' Chromium 安装完成\n');
}

// ── 配置文件检查 ───────────────────────────────────────────────────────────────
function ensureConfig() {
  const cfg = join(ROOT, 'config.yml');
  const example = join(ROOT, 'config.example.yml');

  if (!existsSync(cfg) && existsSync(example)) {
    copyFileSync(example, cfg);
    console.log(yellow('⚠  已自动复制 config.example.yml → config.yml'));
    console.log(yellow('   请编辑 config.yml 填写 Cookie 后再运行下载\n'));
    return false;  // 提示用户需要配置
  }
  return true;
}

// ── 菜单 ───────────────────────────────────────────────────────────────────────
function printMenu(configReady) {
  console.log('');
  console.log(bold('╔══════════════════════════════════════════════╗'));
  console.log(bold('║       抖音下载器 douyin-downloader           ║'));
  console.log(bold('╚══════════════════════════════════════════════╝'));
  console.log('');
  console.log('请选择操作：\n');
  console.log(`  ${yellow('1')}. 运行下载  ${gray('（使用 config.yml 中的链接）')}${configReady ? '' : red('  ← 需先配置 config.yml')}`);
  console.log(`  ${yellow('2')}. 下载单个视频  ${gray('（临时输入视频链接）')}`);
  console.log(`  ${yellow('3')}. 下载账号所有视频  ${gray('（输入主页链接）')}`);
  console.log(`  ${yellow('4')}. 获取 Cookie  ${gray('（启动浏览器自动获取）')}`);
  console.log(`  ${yellow('0')}. 退出`);
  console.log('');
  process.stdout.write('请输入选项: ');
}

function askInput(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (raw) => {
      rl.close();
      resolve(raw.trim());
    });
  });
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
async function main() {
  let python = findPython();
  if (!python) {
    await setupVenv();
    python = findPython();
    if (!python) {
      console.error(red('❌ 安装完成但仍未找到 .venv，请检查环境'));
      process.exit(1);
    }
    console.log('');
  }

  console.log(green('✓') + ` Python: ${gray(python)}`);
  const configReady = ensureConfig();
  printSysInfo(python);

  process.on('SIGINT', () => {
    stopAll();
    setTimeout(() => process.exit(0), 1000);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  printMenu(configReady);

  rl.on('line', async (raw) => {
    const ch = raw.trim();

    if (ch === '1') {
      rl.close();
      launch('下载', python, ['run.py', '-c', 'config.yml']);

    } else if (ch === '2') {
      rl.close();
      const url = await askInput('请输入视频链接: ');
      if (url) {
        launch('下载', python, ['run.py', '-c', 'config.yml', '-u', url]);
      } else {
        console.log(red('❌ 链接为空'));
        process.exit(0);
      }

    } else if (ch === '3') {
      rl.close();
      console.log(gray('支持格式：https://www.douyin.com/user/xxx  或  https://v.douyin.com/xxx/\n'));
      const url = await askInput('请输入账号主页链接: ');
      if (url) {
        launch('下载', python, ['run.py', '-c', 'config.yml', '-u', url]);
      } else {
        console.log(red('❌ 链接为空'));
        process.exit(0);
      }

    } else if (ch === '4') {
      rl.close();
      await ensurePlaywright(python);
      console.log(gray('启动浏览器获取 Cookie，完成后自动写入 config.yml...\n'));
      launch('Cookie获取', python, ['-m', 'tools.cookie_fetcher', '--config', 'config.yml']);

    } else if (ch === '0') {
      rl.close();
      process.exit(0);

    } else {
      console.log(red('❌ 无效选项'));
      process.stdout.write('请输入选项: ');
    }
  });
}

main().catch(e => {
  console.error(red(`❌ ${e.message}`));
  process.exit(1);
});
