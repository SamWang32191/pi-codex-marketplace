import { describe, expect, it } from 'vitest';

import { parseCredentialHelpers, CREDENTIAL_HELPERS_ENV } from '../../../src/registration/credential-helpers.js';

describe('credential-helpers 核准解析（#109）', () => {
  it('環境變數名為 PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS', () => {
    expect(CREDENTIAL_HELPERS_ENV).toBe('PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS');
  });

  it('未設定（undefined）→ 未核准（空清單）', () => {
    expect(parseCredentialHelpers(undefined)).toEqual([]);
  });

  it('空字串 → 未核准（空清單）', () => {
    expect(parseCredentialHelpers('')).toEqual([]);
  });

  it('全空白 → 未核准（空清單）', () => {
    expect(parseCredentialHelpers('   , ,  ')).toEqual([]);
  });

  it('單一 helper → 原樣單項', () => {
    expect(parseCredentialHelpers('store')).toEqual(['store']);
  });

  it('逗號分隔多 helper → 依序保留', () => {
    expect(parseCredentialHelpers('store, cache')).toEqual(['store', 'cache']);
  });

  it('各項 trim 前後空白', () => {
    expect(parseCredentialHelpers('  store ,  cache  ')).toEqual(['store', 'cache']);
  });

  it('空項目忽略（前導／中段／尾隨逗號）', () => {
    expect(parseCredentialHelpers(',store,,cache,')).toEqual(['store', 'cache']);
  });

  it('helper 內容原樣傳遞（不重寫、不截斷）', () => {
    const helper = '!f() { echo "username=x"; echo "password=${PRIVATE_TOKEN}"; }; f';
    expect(parseCredentialHelpers(helper)).toEqual([helper]);
  });
});