# 反代token

将 DeepSeek、Kimi、智谱、豆包、文心一言等 AI 官网网页版封装为本地 OpenAI 兼容 API 的 Electron 桌面应用。

## 功能

- 本地启动 OpenAI 兼容服务，默认地址 `http://127.0.0.1:8349/v1`
- 通过系统默认浏览器（Chrome/Edge）登录官网并抓取 token
- 支持流式与非流式聊天接口
- 模型列表自动从 OpenRouter 公开目录更新

## 源码结构

```text
源代码/
  src/main/        Electron 主进程、服务、适配器
  src/preload/     安全桥接
  src/renderer/    GUI 界面
  package.json     项目配置与构建脚本
```

## 本地开发

```bash
cd 源代码
npm install
npm start
```

## 构建

Windows：

```bash
cd 源代码
npm run dist
```

macOS：

```bash
cd 源代码
npm run dist:mac
```

构建产物输出到 `output/安装包/`。

## GitHub Actions

推送 `v*` 标签后，GitHub Actions 会自动构建 Windows/macOS 安装包并创建 Release。

## 免责声明

本软件仅供个人学习与测试使用，请遵守各 AI 平台的服务条款。