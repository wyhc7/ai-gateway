// ---------------------------------------------------------------------------
// 只生图平台（image_only）的模型闸门
//
// 为什么要单独一个模块：模型清单有三个入口，全都得挡——
//   1. 建平台时前端传来的 model_names
//   2. 平台列表点「刷新」/ 自动刷新，从上游 /models 拉回来的整份目录
//   3. 导入备份、模板预填
// 只在前端挡（Providers.vue 的 applyPreset）挡不住第 2 条：chatgpt2api 的
// /v1/models 会把 gpt-5 系一起吐出来，刷一次就把文本模型灌回来了。
//
// 判据用「像不像生图模型」而不是白名单：上游型号会漂，白名单一过期，
// 新出的生图模型反而被自己的闸门挡掉。反向判文本更糟——漏一个就漏一串。
// 所以这里只认明确带生图语义的名字，其余一律不进。
// ---------------------------------------------------------------------------

export const IMAGE_MODEL_RE = /image|dall-?e|imagen|flux|stable-?diffusion|sd-?xl|sdxl|seedream|kolors|wanx|kandinsky|midjourney|nano-?banana/i

export function isImageModel(id) {
  return IMAGE_MODEL_RE.test(String(id || ''))
}

// 给一个平台过滤模型清单。非 image_only 平台原样返回（同一引用，不动调用方的数组）。
export function filterModelsForProvider(provider, list) {
  const arr = Array.isArray(list) ? list : []
  if (!provider?.image_only) return arr
  return arr.filter((m) => isImageModel(typeof m === 'string' ? m : m?.id))
}

// 模型列表为空的只生图平台，兜底清单就是 gpt-image-2 这一条。
// 不把 codex-gpt-image-2 / gpt-image-1 一起塞进来：前者只有 Plus/Team/Pro 能用，
// 后者是上一代编号，写死在兜底里等于把必然 404 的名字发给客户端。
export const IMAGE_ONLY_FALLBACK_MODELS = ['gpt-image-2']
