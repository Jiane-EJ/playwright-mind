import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * 第一段草稿提升脚本（交接到第二段任务文件）
 * @author Jiane
 */
const DEFAULT_STAGE1_RESULT_DIR = 't_runtime/stage1-results';
const DEFAULT_TARGET_TASK_FILE = 'specs/tasks/acceptance-task.generated.json';
const DRAFT_FILE_NAME = 'draft.acceptance-task.json';

function sanitizeFileName(name) {
  return name.replace(/[^\w.-]/g, '_');
}

function parseCliArgs(argv) {
  const result = {
    requestId: '',
    runDir: '',
    targetFile: '',
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--requestId') {
      result.requestId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--runDir') {
      result.runDir = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--target') {
      result.targetFile = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--force') {
      result.force = true;
    }
  }
  return result;
}

function isDirectory(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function listSubDirectories(parentDir) {
  if (!fs.existsSync(parentDir)) {
    return [];
  }
  return fs
    .readdirSync(parentDir)
    .map((name) => path.join(parentDir, name))
    .filter((item) => isDirectory(item));
}

function buildRunCandidates(baseResultDir, requestId) {
  let requestRootDirs = [];
  if (requestId) {
    const requestDirNames = [...new Set([requestId, sanitizeFileName(requestId)])];
    requestRootDirs = requestDirNames.map((item) => path.join(baseResultDir, item));
  } else {
    requestRootDirs = listSubDirectories(baseResultDir);
  }
  const candidates = [];
  for (let i = 0; i < requestRootDirs.length; i += 1) {
    const requestRootDir = requestRootDirs[i];
    if (!isDirectory(requestRootDir)) {
      continue;
    }
    const runDirs = listSubDirectories(requestRootDir);
    for (let j = 0; j < runDirs.length; j += 1) {
      const runDir = runDirs[j];
      const draftTaskPath = path.join(runDir, DRAFT_FILE_NAME);
      if (!fs.existsSync(draftTaskPath)) {
        continue;
      }
      candidates.push({
        runDir,
        runName: path.basename(runDir),
        requestId: path.basename(requestRootDir),
        draftTaskPath,
      });
    }
  }
  return candidates.sort((a, b) => b.runName.localeCompare(a.runName));
}

function resolveSourceDraftPath(baseResultDir, args) {
  if (args.runDir) {
    const resolvedRunDir = path.resolve(process.cwd(), args.runDir);
    const draftTaskPath = path.join(resolvedRunDir, DRAFT_FILE_NAME);
    if (!fs.existsSync(draftTaskPath)) {
      throw new Error(`指定 runDir 下不存在草稿任务文件: ${draftTaskPath}`);
    }
    return {
      requestId: path.basename(path.dirname(resolvedRunDir)),
      runDir: resolvedRunDir,
      draftTaskPath,
    };
  }
  const candidates = buildRunCandidates(baseResultDir, args.requestId);
  if (candidates.length === 0) {
    throw new Error(
      args.requestId
        ? `未找到 requestId=${args.requestId} 的第一段草稿产物`
        : '未找到任何第一段草稿产物',
    );
  }
  const selected = candidates[0];
  return {
    requestId: selected.requestId,
    runDir: selected.runDir,
    draftTaskPath: selected.draftTaskPath,
  };
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `JSON 解析失败: ${filePath}; ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  const stage1ResultDir = process.env.STAGE1_RESULT_DIR || DEFAULT_STAGE1_RESULT_DIR;
  const targetFile = args.targetFile || DEFAULT_TARGET_TASK_FILE;
  const resolvedStage1ResultDir = path.resolve(process.cwd(), stage1ResultDir);
  const resolvedTargetFile = path.resolve(process.cwd(), targetFile);

  const source = resolveSourceDraftPath(resolvedStage1ResultDir, args);
  if (fs.existsSync(resolvedTargetFile) && !args.force) {
    throw new Error(
      `目标任务文件已存在，请使用 --force 覆盖: ${resolvedTargetFile}`,
    );
  }

  const draftTaskJson = readJsonFile(source.draftTaskPath);
  ensureParentDir(resolvedTargetFile);
  fs.writeFileSync(resolvedTargetFile, JSON.stringify(draftTaskJson, null, 2), 'utf-8');
  const relativeTargetFile = toRelativeDisplayPath(resolvedTargetFile);

  const summary = [
    '第一段草稿任务提升完成',
    `source.requestId=${source.requestId}`,
    `source.runDir=${source.runDir}`,
    `source.draftTask=${source.draftTaskPath}`,
    `target.taskFile=${resolvedTargetFile}`,
    `target.taskFileRelative=${relativeTargetFile}`,
    `建议：STAGE2_TASK_FILE=${relativeTargetFile}`,
    '下一步：npm run stage2:run:headed',
  ].join('\n');
  console.log(summary);
}

try {
  main();
} catch (error) {
  console.error(
    `[stage1-promote] 执行失败: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
