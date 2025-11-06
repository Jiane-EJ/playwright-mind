# /login 页面端到端测试计划

## 概要

此文档为 ` /login ` 页面准备端到端（E2E）测试用例，包含两条核心场景：成功登录和密码错误。

目标是模拟真实用户行为，验证登录流程在正常和异常输入下的功能、错误提示和导航。测试基于 Playwright，并已在仓库中添加测试实现 `tests/login.spec.ts`（请根据实际应用调整选择器与 URL）。

假设
- 测试在一个干净/新会话中执行（未登录状态）。
- 应用可通过可配置的 BASE_URL 访问（默认 `http://localhost:3000`）。
- 已在测试环境准备对应的测试账号或通过环境变量注入凭据。

质量衡量点
- 成功登录：页面应导航到受保护区（如 `/dashboard`、`/home` 或 `/profile` 等），并展示登录后 UI 元素（例如 "Logout"、"Profile"）。
- 密码错误：应在页面上显示错误信息，且不应导航到受保护区。

---

## 环境与运行说明

测试文件：`tests/login.spec.ts`

可配置的环境变量（可在 CI 或本地会话中设置）：
- `BASE_URL` 或 `PLAYWRIGHT_BASE_URL`：应用根 URL，默认 `http://localhost:3000`。
- `TEST_USERNAME`：测试账号用户名或邮箱（默认 `testuser`）。
- `TEST_PASSWORD`：测试账号正确密码（默认 `correct-password`）。
- `TEST_INVALID_PASSWORD`：用于错误场景的错误密码（默认 `wrong-password`）。

在 PowerShell 中运行单个测试文件的示例：

```powershell
$env:BASE_URL = "http://localhost:3000"
$env:TEST_USERNAME = "testuser"
$env:TEST_PASSWORD = "correct-password"
$env:TEST_INVALID_PASSWORD = "wrong-password"
npx playwright test tests/login.spec.ts -c playwright.config.ts
```

如果想运行完整测试套件，移除文件路径参数：

```powershell
npx playwright test -c playwright.config.ts
```

注意：如果你在 CI 中运行，请在管道中以环境变量注入上面的值，或使用安全的凭据注入机制。

---

## 场景 1：成功登录（Happy Path）

前置状态：打开浏览器，未登录，入口页面为空白会话。

步骤：
1. 访问 `{{BASE_URL}}/login` 页面。
2. 在用户名或邮箱输入框中输入有效用户名（例如 `testuser`）。
3. 在密码输入框中输入正确密码（例如 `correct-password`）。
4. 点击 "提交" 按钮（或在密码框按 Enter）。
5. 等待导航完成或登录成功的 UI 元素出现。

期望结果：
- 页面导航到受保护页面（URL 包含 `dashboard`、`home`、`profile` 或其他登录后首页），或显示受保护区的显著元素。
- 页面上出现登录后特有的元素，例如 "Logout"、"Profile" 或用户名称。

成功条件：
- 上述断言至少有一个成立：URL 匹配预期，或登录后 UI 元素可见。

失败条件：
- 页面仍停留在 `/login`，没有显示任何登录后元素。
- 出现与登录无关的错误（服务端 5xx、页面崩溃等）。

备注与调整点：
- 如果应用使用 `email` 而不是 `username`，请在测试中将选择器调整为 `input[name="email"]`。
- 如果登录后不会跳转但会局部刷新（例如显示对话框或侧边栏），请更新断言以检测该 UI 变化。

---

## 场景 2：密码错误（Negative Case）

前置状态：打开浏览器，未登录。

步骤：
1. 访问 `{{BASE_URL}}/login` 页面。
2. 在用户名或邮箱输入框中输入有效用户名（例如 `testuser`）。
3. 在密码输入框中输入错误密码（例如 `wrong-password`）。
4. 点击 "提交" 按钮（或在密码框按 Enter）。
5. 等待错误提示出现。

期望结果：
- 页面显示明确的错误消息（例如包含关键字："Invalid"、"incorrect"、"密码"、"用户名或密码错误" 等）。
- 页面不应导航到受保护页面，用户仍保持未登录状态。

成功条件：
- 错误消息可见，并且 URL 未发生到登录后页面的导航。

失败条件：
- 未显示错误消息且发生了登录（泄露凭据或后端异常）。
- 显示与表单无关的异常错误（例如 500 错误）。

备注与调整点：
- 不同应用的错误文案不同；若未检测到默认关键字，请将测试中的 `errorLocator` 选择器替换为确切的错误元素选择器（例如 `.error-message`）。

---

## 测试实现说明（`tests/login.spec.ts`）

实现要点：
- 已加入对常见选择器的兼容写法（`input[name="username"], input[name="email"]`），并尝试多种提交按钮文本（`Login`、`登录`）。
- 使用环境变量以便在不同环境（本地/CI）下复用。 
- 包含对常见错误消息关键字的检测，便于快速发现登录失败的 UI 反馈。

如果在运行时出现断言或选择器失败，优先检查：
1. `BASE_URL` 是否正确且应用服务已启动。
2. 表单字段的 `name`、按钮文本或错误消息的实际 HTML 是否与测试中的选择器匹配。
3. 是否需要在 `playwright.config.ts` 中配置 `webServer` 来在测试前启动本地服务器。

---

## 建议的后续改进（可选）

- 为登录测试添加更多场景：空密码、空用户名、账户锁定、多因素认证（MFA）流程。
- 将登录凭据保存在测试凭据管理服务中，避免在 CI 日志中泄漏。
- 为关键路径添加简单的断言计时（响应时间阈值），用于性能回归检测。
- 若登录需要后端 mock，提供 mock/stub 方案以隔离前端逻辑。

---

## 完成状态与下一步

已完成：
- 在仓库中添加测试实现文件 `tests/login.spec.ts`（包含成功登录与密码错误场景）。
- 本文档 `specs/login-e2e.md` 已保存以供 QA/开发参考。

建议下一步：在本地用以下命令执行测试并观察失败信息，随后根据实际 DOM 更新测试中的选择器或环境配置。

```powershell
# 在 PowerShell 中设置 env 并运行单个测试
$env:BASE_URL = "http://localhost:3000"
$env:TEST_USERNAME = "testuser"
$env:TEST_PASSWORD = "correct-password"
$env:TEST_INVALID_PASSWORD = "wrong-password"
npx playwright test tests/login.spec.ts -c playwright.config.ts
```

如需我进一步：
- 我可以帮你运行测试（如果你允许我访问运行环境），或
- 根据你提供的 `/login` 页面 HTML 快照（或选择器）精确调整测试选择器。

---

文件路径： `specs/login-e2e.md`
