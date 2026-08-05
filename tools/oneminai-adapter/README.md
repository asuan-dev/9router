# 1min.ai → OpenAI 兼容适配器

把 1min.ai 自定义 API 格式转成标准 OpenAI `/v1/chat/completions`，供 AxonHub 等 OpenAI 兼容客户端使用。

## 运行

```bash
python3 adapter.py --port 3199 --api-key YOUR_1MIN_API_KEY
```

## AxonHub 渠道配置

| 字段 | 值 |
|---|---|
| 类型 | `openai` |
| base_url | `http://127.0.0.1:3199/v1` |
| API Key | 随便填（适配器不校验入站 key） |
| 模型 | `gpt-4o-mini`、`claude-sonnet-4-6`、`gpt-4o`、`gemini-3.5-flash`、`deepseek-chat` |

## 工作原理

```
AxonHub (标准 OpenAI 格式)
  → 适配器 (http://127.0.0.1:3199)
    → 1min.ai API (https://api.1min.ai/api/chat-with-ai)
      → OpenAI / Anthropic / Google 上游模型
```

适配器做两件事：
1. **请求转换**：OpenAI `messages` 数组 → 1min.ai `promptObject.prompt`
2. **响应转换**：1min.ai `aiRecordDetail.resultObject` → OpenAI `choices[0].message.content`

## 已验证

- `gpt-4o-mini` 单轮对话 ✅
- `claude-sonnet-4-6` 单轮对话 ✅
- 多轮对话（system + user + assistant + user）✅
- `/v1/models` 模型列表 ✅

## 注意

- 1min.ai 的 API 不是 OpenAI 兼容格式，没有 `/v1/chat/completions` 端点
- 1min.ai 用 `API-KEY` header 而非 `Authorization: Bearer`
- Cloudflare 会拦截默认 urllib User-Agent，适配器已加自定义 UA
- 1min.ai 免费层消耗 credits（gpt-4o-mini 约 60 credits/次，claude-sonnet-4-6 约 2574 credits/次）
