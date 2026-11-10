'use strict';
// 툴 정의 공용 조각 — strict 스키마(모든 인자 required, additionalProperties false).
const prop = (type, description, extra = {}) => ({ type, description, ...extra });
const obj = (properties = {}) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const out = (o, isError = false) => ({ content: JSON.stringify(o), isError });
const keysOf = (ctx) => Object.keys(ctx.kb?.sections || {});
// 지식베이스 절 키 배열 — 절이 있으면 enum으로 묶는다(없는 키를 지어내지 못하게).
const sectionKeys = (ctx, description) => prop('array', description, { items: keysOf(ctx).length ? { type: 'string', enum: keysOf(ctx) } : { type: 'string' } });
module.exports = { prop, obj, out, keysOf, sectionKeys };
