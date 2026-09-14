export const DESCRIPTION = `Analyze an image with a vision model (cloud-first: DeepSeek deepseek-flash; local fallback: Qwen3-VL-8B). Use for reading screenshots, paper pages, formula images, charts, or documents.
- image_path: absolute path to the image (png/jpg/jpeg/gif/webp/bmp)
- task (optional): 'latex' = formulas → LaTeX, 'markdown' = document → Markdown (formulas as LaTeX), 'describe' = describe image. Default 'latex'.
- custom_prompt (optional): override task with a freeform instruction.
Default: cloud model deepseek-flash. If it fails, automatically falls back to the local Qwen3-VL-8B (auto-starts on port 8081, auto-stops after 3 minutes idle).
Note: the cloud model is a reasoning model, so its "thinking" is disabled by default — otherwise it burns the entire max_tokens budget on reasoning and returns empty content.
Overrides via config.json keys (or env): visionProvider ('auto'|'cloud'|'local'), visionModel, visionThinking (true to re-enable reasoning).
Env: MYTHINKNODE_VISION / MYTHINKNODE_VISION_MODEL / MYTHINKNODE_VISION_THINKING=1.`;
