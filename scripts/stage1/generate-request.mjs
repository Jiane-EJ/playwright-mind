import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * 第一段自然语言请求转 JSON 脚本
 * @author Jiane
 */
const DEFAULT_BRIEF_FILE = 'specs/stage1/stage1-brief.txt';
const DEFAULT_OUTPUT_FILE = 'specs/stage1/stage1-request.generated.json';
const DEFAULT_REQUEST_NAME = '第一段-自动生成探索建模请求';
const DEFAULT_STEP_TIMEOUT_MS = 30000;
const DEFAULT_PAGE_TIMEOUT_MS = 60000;
const DEFAULT_EXPLORATION_DEPTH = 'deep';
const DEFAULT_INTERACTION_TARGETS = [
  '按钮',
  '超链接',
  '输入框',
  '文本域',
  '日期框',
  '单选框',
  '多选框',
  '下拉框',
  '级联下拉框',
];

function nowStamp() {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

function uniqueNonEmpty(values) {
  const normalized = values
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
  return [...new Set(normalized)];
}

function parseCliArgs(argv) {
  const result = {
    text: '',
    file: '',
    output: '',
    requestId: '',
    requestName: '',
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--text') {
      result.text = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--file') {
      result.file = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--output') {
      result.output = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--requestId') {
      result.requestId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--requestName') {
      result.requestName = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--force') {
      result.force = true;
    }
  }
  return result;
}

function readTextFromFile(rawFilePath) {
  const resolvedFilePath = path.resolve(process.cwd(), rawFilePath.trim());
  if (!fs.existsSync(resolvedFilePath)) {
    throw new Error(`输入文件不存在: ${resolvedFilePath}`);
  }
  const rawContent = fs.readFileSync(resolvedFilePath, 'utf-8');
  const ext = path.extname(resolvedFilePath).toLowerCase();
  const textContent = ext === '.html' || ext === '.htm'
    ? rawContent
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    : rawContent.trim();
  return {
    source: resolvedFilePath,
    text: textContent,
  };
}

function readSourceText(args) {
  if (args.file.trim().length > 0) {
    return readTextFromFile(args.file);
  }

  const briefFilePath = (
    process.env.STAGE1_BRIEF_FILE || DEFAULT_BRIEF_FILE
  ).trim();
  if (briefFilePath.length > 0) {
    const briefResult = readTextFromFile(briefFilePath);
    if (briefResult.text.length > 0) {
      return briefResult;
    }
    throw new Error(`固定 brief 文件内容为空: ${briefResult.source}`);
  }

  if (args.text.trim().length > 0) {
    return {
      source: 'cli_text',
      text: args.text.trim(),
    };
  }

  const envBrief = (process.env.STAGE1_BRIEF_TEXT || '').trim();
  if (envBrief.length > 0) {
    return {
      source: 'env:STAGE1_BRIEF_TEXT',
      text: envBrief,
    };
  }
  throw new Error('缺少输入，请先填写 STAGE1_BRIEF_FILE 指向的固定 brief 文件');
}

function normalizeBriefText(input) {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.');
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match || !match[0]) {
    throw new Error('未识别到 URL，请在文本中提供 http/https 地址');
  }
  return match[0].replace(/[),.]+$/, '');
}

function extractAccountAndPassword(text) {
  const compact = text.replace(/\s+/g, ' ');
  const pairMatch = compact.match(
    /账号\s*\/\s*密码\s*:\s*([^\s\/,.;]+)\s*\/\s*([^\s,.;]+)/i,
  );
  if (pairMatch && pairMatch[1] && pairMatch[2]) {
    return {
      username: pairMatch[1].trim(),
      password: pairMatch[2].trim(),
    };
  }

  const accountMatch = compact.match(/账号(?:\/用户名)?\s*:\s*([^\s,.;]+)/i);
  const passwordMatch = compact.match(/密码\s*:\s*([^\s,.;]+)/i);
  if (accountMatch && passwordMatch && accountMatch[1] && passwordMatch[1]) {
    return {
      username: accountMatch[1].trim(),
      password: passwordMatch[1].trim(),
    };
  }
  throw new Error('未识别到账号/密码，请使用“账号/密码: xxx/yyy”或“账号: xxx 密码: yyy”格式');
}

function extractScenarioDescription(text) {
  const match = text.match(/测试要求\s*:\s*([\s\S]+)/i);
  if (match && match[1] && match[1].trim().length > 0) {
    return match[1].trim();
  }
  return text.trim();
}

function extractMenuPathHints(scenarioDescription) {
  const values = [];
  const menuRegex = /找到([^,.;\n]{1,20})菜单/g;
  const subMenuRegex = /子菜单([^,.;\n]{1,20})/g;
  let match = menuRegex.exec(scenarioDescription);
  while (match && match[1]) {
    values.push(match[1].trim());
    match = menuRegex.exec(scenarioDescription);
  }
  match = subMenuRegex.exec(scenarioDescription);
  while (match && match[1]) {
    values.push(match[1].trim());
    match = subMenuRegex.exec(scenarioDescription);
  }
  return uniqueNonEmpty(values);
}

function buildMustExploreAreas(scenarioDescription, menuPathHints) {
  const areas = [...menuPathHints];
  if (scenarioDescription.includes('首页')) {
    areas.push('首页');
  }
  if (scenarioDescription.includes('新增') || scenarioDescription.includes('录入')) {
    areas.push('新增');
  }
  if (scenarioDescription.includes('搜索') || scenarioDescription.includes('筛选')) {
    areas.push('搜索');
  }
  if (scenarioDescription.includes('列表') || scenarioDescription.includes('表格')) {
    areas.push('列表');
  }
  const uniqueAreas = uniqueNonEmpty(areas);
  if (uniqueAreas.length > 0) {
    return uniqueAreas;
  }
  return ['首页', '列表', '新增'];
}

function resolveExplorationDepth(scenarioDescription) {
  if (/快速|仅需基础|轻量/.test(scenarioDescription)) {
    return 'basic';
  }
  return DEFAULT_EXPLORATION_DEPTH;
}

function resolveInteractionTargets(scenarioDescription) {
  const targets = [...DEFAULT_INTERACTION_TARGETS];
  if (/日期|时间/.test(scenarioDescription)) {
    targets.push('日期时间选择器');
  }
  if (/单选|多选/.test(scenarioDescription)) {
    targets.push('选项组');
  }
  if (/上传|导入/.test(scenarioDescription)) {
    targets.push('上传控件');
  }
  return uniqueNonEmpty(targets);
}

function buildRequestPayload(briefText, args) {
  const normalized = normalizeBriefText(briefText);
  const url = extractUrl(normalized);
  const account = extractAccountAndPassword(normalized);
  const scenarioDescription = extractScenarioDescription(normalized);
  const menuPathHints = extractMenuPathHints(scenarioDescription);
  const mustExploreAreas = buildMustExploreAreas(
    scenarioDescription,
    menuPathHints,
  );
  const explorationDepth = resolveExplorationDepth(scenarioDescription);
  const interactionTargets = resolveInteractionTargets(scenarioDescription);
  const requestId = (args.requestId || '').trim() || `stage1-auto-${nowStamp()}`;
  const requestName = (args.requestName || '').trim() || DEFAULT_REQUEST_NAME;

  return {
    requestId,
    requestName,
    target: {
      url,
      browser: 'chromium',
      headless: false,
    },
    account: {
      username: account.username,
      password: account.password,
      loginHints: [
        '用户名输入框可能显示为账号、用户名或登录名',
        '密码输入框可能显示为密码',
        '提交按钮可能显示为登录或立即登录',
      ],
    },
    goal: {
      scenarioDescription,
      expectedOutcome: '输出可人工复核的 draft.acceptance-task.json',
    },
    scope: {
      menuPathHints,
      mustExploreAreas,
      skipAreas: ['与本场景无关菜单'],
      explorationDepth,
      interactionTargets,
    },
    review: {
      required: true,
      reviewer: 'manual-review',
    },
    runtime: {
      stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      pageTimeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
      screenshotOnStep: true,
    },
  };
}

function ensureDir(targetFilePath) {
  fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
}

function writeRequestFile(targetFilePath, payload, force) {
  if (fs.existsSync(targetFilePath) && !force) {
    throw new Error(`目标文件已存在，请使用 --force 覆盖: ${targetFilePath}`);
  }
  ensureDir(targetFilePath);
  fs.writeFileSync(targetFilePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function toRelativeDisplayPath(fullPath) {
  const relativePath = path.relative(process.cwd(), fullPath);
  if (!relativePath) {
    return path.basename(fullPath);
  }
  return relativePath.split(path.sep).join('/');
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const sourceInput = readSourceText(args);
  const payload = buildRequestPayload(sourceInput.text, args);
  const outputFile = (args.output || DEFAULT_OUTPUT_FILE).trim();
  const resolvedOutputFile = path.resolve(process.cwd(), outputFile);
  const relativeOutputFile = toRelativeDisplayPath(resolvedOutputFile);
  writeRequestFile(resolvedOutputFile, payload, args.force);

  const summary = [
    '第一段请求 JSON 生成完成',
    `source=${sourceInput.source}`,
    `requestId=${payload.requestId}`,
    `output=${resolvedOutputFile}`,
    `outputRelative=${relativeOutputFile}`,
    `建议：STAGE1_REQUEST_FILE=${relativeOutputFile}`,
    '下一步：npm run stage1:run:headed',
  ].join('\n');
  console.log(summary);
}

try {
  main();
} catch (error) {
  console.error(
    `[stage1-generate-request] 执行失败: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
