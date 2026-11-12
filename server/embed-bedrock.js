'use strict';
// 임베딩 공급자 bedrock-cohere — Amazon Bedrock Cohere Embed v4(InvokeModel). 의존성 0: 서명·자격 증명은 server/aws.js.
// 설정(env, 호출 때 읽는다): BEDROCK_EMBED_MODEL(global.cohere.embed-v4:0) · BEDROCK_EMBED_DIM(1536, 256|512|1024|1536)
//   · BEDROCK_REGION(비우면 AWS_REGION) · EMBED_TIMEOUT_MS(10000).
// 공급자 model 식별자 = <모델 ID>@<차원> — 차원이 바뀌면 다른 색인(저장소는 model로 색인을 나눈다).
// 오류 코드: embed_auth(401·403·자격 증명 없음) · embed_throttled(429를 두 번 다시 보내도 실패) · embed_timeout · embed_invalid(응답 모양) · embed_error(그 밖).
// 오류 메시지에는 상태·AWS 오류 코드·짧은 이유만 둔다 — 키·세션 토큰·Authorization·서명은 넣지 않는다.
const aws = require('./aws');

const NAME = 'bedrock-cohere';
const DEFAULT_MODEL = 'global.cohere.embed-v4:0';
const DIMS = [256, 512, 1024, 1536];
const DEFAULT_DIM = 1536;
const DEFAULT_TIMEOUT_MS = 10000;
// Bedrock Cohere Embed v4 문서: texts는 호출당 최대 96개
const MAX_TEXTS = 96;
const THROTTLE_WAITS_MS = [500, 1500]; // 429면 이만큼 쉬고 다시(최대 2회)
const INPUT_TYPE = { document: 'search_document', query: 'search_query' };

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const str = (v) => String(v ?? '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** env에서 설정을 읽는다. 형식이 틀리면 embed_config(검사는 preflight도 한다). */
function settings(env = process.env) {
  const d = str(env.BEDROCK_EMBED_DIM);
  if (d && !DIMS.includes(Number(d))) throw fail('embed_config', `BEDROCK_EMBED_DIM=${d} — ${DIMS.join(' | ')}`);
  const t = str(env.EMBED_TIMEOUT_MS);
  if (t && !/^[1-9]\d*$/.test(t)) throw fail('embed_config', `EMBED_TIMEOUT_MS=${t} — 1 이상의 정수`);
  const modelId = str(env.BEDROCK_EMBED_MODEL) || DEFAULT_MODEL;
  const region = str(env.BEDROCK_REGION) || aws.region(env);
  return {
    modelId, region, dim: d ? Number(d) : DEFAULT_DIM, timeoutMs: t ? Number(t) : DEFAULT_TIMEOUT_MS,
    // 추론 방식: 교차 리전 추론 프로필 접두어(global·us·eu·apac…)면 그것, 아니면 리전 안(on-demand)
    inference: /^(global|us|eu|apac|jp|au|ca|us-gov)\./.exec(modelId)?.[1] || 'in-region',
  };
}

const endpoint = (region) => `https://bedrock-runtime.${region}.amazonaws.com`;
const urlOf = (s) => `${endpoint(s.region)}/model/${encodeURIComponent(s.modelId)}/invoke`;

/** 오류를 우리 코드로. 메시지는 상태·AWS 코드·이유 앞부분만, 그 안의 자격 증명 값은 가린다. */
function classify(e, env) {
  const secrets = [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].filter((v) => v && String(v).length >= 4);
  const clean = (m) => secrets.reduce((s, v) => s.split(v).join('***'), String(m || '')).replace(/(authorization|signature|credential)\S*/gi, '***').slice(0, 160);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return fail('embed_timeout', 'bedrock 응답 시간 초과');
  const status = Number(e?.status) || 0;
  const awsCode = str(e?.code);
  if (status === 401 || status === 403 || /AccessDenied|UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|ExpiredToken|InvalidClientTokenId/.test(awsCode)
    || /^aws 자격 증명 없음/.test(e?.message || '')) {
    return fail('embed_auth', `bedrock 권한 거부${status ? ` ${status}` : ''}${awsCode ? ` ${awsCode}` : ''}${status ? '' : ' (자격 증명 없음)'}`);
  }
  if (status === 429 || /Throttling|TooManyRequests/.test(awsCode)) return fail('embed_throttled', `bedrock 요청 제한 ${status || ''} ${awsCode}`.trim());
  if (status) {
    // aws.request 메시지 = "<service> <status> <code>: <본문>" — 본문의 message만 짧게
    const reason = /"message"\s*:\s*"([^"]*)"/i.exec(e.message || '')?.[1] || '';
    return fail('embed_error', `bedrock ${status} ${awsCode}${reason ? `: ${clean(reason)}` : ''}`.trim());
  }
  return fail('embed_error', `bedrock 호출 실패: ${clean(e?.cause?.code || e?.message || 'unknown')}`);
}

/**
 * 공급자 객체를 만든다 — embed.js가 호출마다 env로 만든다. deps는 시험용(request·sleep 바꿔 끼우기).
 * raw(texts, inputType) → 정규화 전 벡터 배열. 문장은 MAX_TEXTS씩 나눠 보낸다.
 */
function create(env = process.env, deps = {}) {
  const s = settings(env);
  const request = deps.request || aws.request;
  const wait = deps.sleep || sleep;
  const once = async (texts, inputType) => {
    const body = JSON.stringify({ texts, input_type: INPUT_TYPE[inputType], embedding_types: ['float'], output_dimension: s.dim });
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await request({ service: 'bedrock', url: urlOf(s), method: 'POST', region: s.region, timeoutMs: s.timeoutMs,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
      } catch (e) {
        const c = classify(e, env);
        if (c.code === 'embed_throttled' && attempt < THROTTLE_WAITS_MS.length) { await wait(THROTTLE_WAITS_MS[attempt]); continue; }
        throw c;
      }
      let j;
      try { j = await res.json(); } catch (e) { throw classify(e, env).code === 'embed_timeout' ? fail('embed_timeout', 'bedrock 응답 시간 초과') : fail('embed_invalid', 'bedrock 응답이 JSON이 아니다'); }
      const v = j?.embeddings?.float;
      if (!Array.isArray(v)) throw fail('embed_invalid', 'bedrock 응답에 embeddings.float 없음');
      return v; // 개수·차원·NaN·영벡터는 embed.normalize가 본다
    }
  };
  return {
    name: NAME, model: `${s.modelId}@${s.dim}`, dim: s.dim, region: s.region, inference: s.inference,
    async raw(texts, inputType) {
      const out = [];
      for (let i = 0; i < texts.length; i += MAX_TEXTS) out.push(...await once(texts.slice(i, i + MAX_TEXTS), inputType));
      return out;
    },
  };
}

module.exports = { create, settings, classify, endpoint, NAME, DIMS, MAX_TEXTS, DEFAULT_MODEL, THROTTLE_WAITS_MS, INPUT_TYPE };
