import { describe, expect, it } from 'vitest'
import { agentModeTokens, modelInfo, windowOf } from '../src/provider'

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
