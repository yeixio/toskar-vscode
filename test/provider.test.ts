import { describe, expect, it } from 'vitest'
import { agentModeTokens, modelError, modelInfo, windowOf } from '../src/provider'
import { ToskarError } from '../src/toskar'

describe('windowOf', () => {
  it('counts on the largest window that still fits, since Toskar grows to it', () => {
    const m = {
      id: 'qwen3-8b',
      context_window: 16384,
      context_options: [
        { tokens: 16384, fit: 'excellent' },
        { tokens: 32768, fit: 'good' },
        { tokens: 65536, fit: 'tight' },
        { tokens: 131072, fit: 'heavy' },
      ],
    }
    expect(windowOf(m)).toBe(65536)
  })

  it('keeps the window it starts with when nothing bigger fits', () => {
    expect(windowOf({ id: 'a', context_window: 16384, context_options: [{ tokens: 32768, fit: 'too_large' }] })).toBe(16384)
  })

  it('falls back to 8192 when Toskar says nothing', () => {
    expect(windowOf({ id: 'a' })).toBe(8192)
  })
})

describe('modelInfo', () => {
  it("tells Copilot the room Agent mode's tools need", () => {
    const info = modelInfo({ id: 'a', context_window: 8192, context_options: [{ tokens: 65536, fit: 'good' }] }, 'rig')
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(65536)
    expect(info.maxInputTokens).toBeGreaterThan(agentModeTokens)
    expect(info.detail).toBe('Toskar')
  })

  it('says to use Ask mode when no window holds Agent mode', () => {
    const info = modelInfo({ id: 'a', display_name: 'Big', context_window: 16384 }, 'rig')
    expect(info.detail).toBe('Toskar · 16K, Ask mode')
    expect(info.tooltip).toContain('Ask mode')
  })
})

describe('modelError', () => {
  it("tells Copilot a key that isn't allowed isn't worth trying again", () => {
    const err = modelError(new ToskarError("this key can't drive a model directly", 403, 'RAW_NOT_ALLOWED')) as Error & { code: string }
    expect(err.code).toBe('NoPermissions')
    expect(err.message).toContain("can't drive a model directly")
  })

  it('says a missing model is missing', () => {
    expect((modelError(new ToskarError('gone', 404)) as { code: string }).code).toBe('NotFound')
  })

  it('leaves other failures as they are', () => {
    const err = new ToskarError('the model didn\'t answer', 502)
    expect(modelError(err)).toBe(err)
    const plain = new Error('x')
    expect(modelError(plain)).toBe(plain)
  })
})
