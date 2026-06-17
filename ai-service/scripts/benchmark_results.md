# Thai->English translation model benchmark

- Endpoint: `https://openrouter.ai/api/v1`
- Params: temperature=0.2, max_tokens=1024, single user message (production-identical)
- Models tested: 8 | Sentences: 8

## Latency leaderboard (median over successful calls)

| Rank | Model | Median | Mean | Min | Max | OK | Err |
|----|------|------|----|----|----|----|----|
| 1 | `meta-llama/llama-3.3-70b-instruct` | 0.68s | 0.93s | 0.59s | 1.78s | 8 | 0 |
| 2 | `openai/gpt-4o-mini` | 0.75s | 0.82s | 0.61s | 1.46s | 8 | 0 |
| 3 | `openai/gpt-4.1-nano` | 0.85s | 0.99s | 0.71s | 1.91s | 8 | 0 |
| 4 | `google/gemini-2.5-flash` | 0.97s | 1.73s | 0.79s | 6.92s | 8 | 0 |
| 5 | `openai/gpt-4.1-mini` | 0.99s | 1.04s | 0.94s | 1.25s | 8 | 0 |
| 6 | `qwen/qwen-2.5-72b-instruct` | 1.17s | 1.57s | 0.57s | 4.91s | 8 | 0 |
| 7 | `anthropic/claude-3.5-haiku` | 1.38s | 1.35s | 0.93s | 1.68s | 8 | 0 |

**Unavailable:** `google/gemini-2.0-flash-001`

## Translations side-by-side (judge quality here)

### `สวัสดี`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | Hello. |
| `openai/gpt-4o-mini` | Hello. |
| `openai/gpt-4.1-nano` | Hello |
| `google/gemini-2.5-flash` | Hello. |
| `openai/gpt-4.1-mini` | Hello |
| `qwen/qwen-2.5-72b-instruct` | Hello |
| `anthropic/claude-3.5-haiku` | Hi there hello! |

### `ดีครับ ทำอะไรอยู่ครับ`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | What are you doing? |
| `openai/gpt-4o-mini` | Hello, what are you doing? |
| `openai/gpt-4.1-nano` | Hello, what are you doing? |
| `google/gemini-2.5-flash` | Hello. What are you doing? |
| `openai/gpt-4.1-mini` | Good, what are you doing? |
| `qwen/qwen-2.5-72b-instruct` | Hi there. What are you doing? |
| `anthropic/claude-3.5-haiku` | Hi there! What are you doing? |

### `วันนี้ฉันจะมา`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | I'm coming today. |
| `openai/gpt-4o-mini` | Today I will come. |
| `openai/gpt-4.1-nano` | Today, I will come. |
| `google/gemini-2.5-flash` | Today I will come |
| `openai/gpt-4.1-mini` | Today I am going to |
| `qwen/qwen-2.5-72b-instruct` | Today I will come. |
| `anthropic/claude-3.5-haiku` | Today I will come. |

### `นิทานเรื่องกระต่ายกับเต่า`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | The story of the rabbit and the turtle. |
| `openai/gpt-4o-mini` | The story of the rabbit and the turtle. |
| `openai/gpt-4.1-nano` | The story of the rabbit and the turtle. |
| `google/gemini-2.5-flash` | The story of the Tortoise and the Hare. |
| `openai/gpt-4.1-mini` | The story of the rabbit and the turtle |
| `qwen/qwen-2.5-72b-instruct` | The story of the rabbit and the tortoise. |
| `anthropic/claude-3.5-haiku` | The story of the rabbit and the turtle |

### `ง่วงมะขามมะยม`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | I'm sleepy. |
| `openai/gpt-4o-mini` | I'm feeling sleepy. |
| `openai/gpt-4.1-nano` | I'm sleepy. |
| `google/gemini-2.5-flash` | Are you sleepy? |
| `openai/gpt-4.1-mini` | Are you sleepy? |
| `qwen/qwen-2.5-72b-instruct` | I'm sleepy. |
| `anthropic/claude-3.5-haiku` | I'm feeling really sleepy. |

### `มะม่วง`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | Mango |
| `openai/gpt-4o-mini` | mango |
| `openai/gpt-4.1-nano` | Mango |
| `google/gemini-2.5-flash` | Mango |
| `openai/gpt-4.1-mini` | Mango |
| `qwen/qwen-2.5-72b-instruct` | Mango |
| `anthropic/claude-3.5-haiku` | Mango |

### `วันนี้เราจะมาเรียนเรื่องระบบสุริยะ ดวงอาทิตย์เป็นศูนย์กลางและมีดาวเคราะห์แปดดวงโคจรอยู่รอบ`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | Today, we're going to learn about the solar system. The sun is at the center and there are eight planets orbiting around it. |
| `openai/gpt-4o-mini` | Today we will learn about the solar system. The sun is the center, and there are eight planets orbiting around it. |
| `openai/gpt-4.1-nano` | Today, we will learn about the solar system. The Sun is at the center, and eight planets orbit around it. |
| `google/gemini-2.5-flash` | Today we will learn about the solar system. The sun is at the center and there are eight planets orbiting around it. |
| `openai/gpt-4.1-mini` | Today we will learn about the solar system. The sun is at the center, and eight planets orbit around it. |
| `qwen/qwen-2.5-72b-instruct` | Today we will learn about the solar system. The sun is at the center, and eight planets orbit around it. |
| `anthropic/claude-3.5-haiku` | Today we will learn about the solar system. The sun is at the center, and eight planets orbit around it. |

### `นักเรียนทุกคนเปิดหนังสือหน้าสามสิบสองแล้วอ่านตามครูพร้อมกันนะคะ`

| Model | Output |
|------|------|
| `meta-llama/llama-3.3-70b-instruct` | Everyone, please open your book to page thirty-two and read along with the teacher. |
| `openai/gpt-4o-mini` | Everyone, please open your books to page thirty-two and read along with me. |
| `openai/gpt-4.1-nano` | Everyone, open your books to page 32 and read along with the teacher. |
| `google/gemini-2.5-flash` | Everyone, open your books to page thirty-two and read along with me. |
| `openai/gpt-4.1-mini` | Everyone, please open your books to page thirty-two and read along with me. |
| `qwen/qwen-2.5-72b-instruct` | Everyone, open your books to page thirty-two and read along with me. |
| `anthropic/claude-3.5-haiku` | Everyone, please open your books to page 32 and read along with me. |
