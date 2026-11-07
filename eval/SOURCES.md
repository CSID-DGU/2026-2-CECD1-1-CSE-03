# 평가 세트 출처와 저작자 표시

시나리오 문장은 우리가 새로 쓴 한국어다. 외부 데이터셋의 원문은 이 저장소에 복사하지 않는다. 아래 표는 데이터셋 이름, 라이선스, 허용된 쓰임, 저작자 표시를 적는다.

쓰임의 뜻은 다음과 같다.

- 문장 각색: 출처를 밝히고 문장을 한국어로 고쳐 쓴다.
- 범주만: 분류 이름과 개념만 참조한다. 문장은 쓰지 않는다.
- 기법 계열만: 공격 기법의 종류만 참조한다. 원문 문장은 쓰지 않는다.

| 데이터셋 | 라이선스 | 허용된 쓰임 | 공개 주소 |
|---|---|---|---|
| τ-bench / τ²-bench (Sierra Research) | MIT | 사용자 시뮬레이터 원칙, 과제 형식, pass^k, 한국어 화용 지침을 우리 문장으로 다시 씀 | https://github.com/sierra-research/tau-bench , https://github.com/sierra-research/tau2-bench |
| ABCD (ASAPP Research) | MIT | 흐름 이름 또는 짧은 영어 발화를 한국어로 각색(문장 각색) | https://github.com/asappresearch/abcd |
| Banking77 (PolyAI) | CC BY 4.0 | 결제·환불·카드 라벨 이름(범주만) | https://huggingface.co/datasets/PolyAI/banking77 |
| CLINC150 / OOS (Clinc) | CC BY 3.0 | 범위 밖 질문이라는 개념(범주만) | https://github.com/clinc/oos-eval |
| Bitext 고객지원 데이터 | CDLA-Sharing-1.0 | 의도 범주 이름과 말투 태그(범주만). 데이터 자체는 저장소에 두지 않는다 | https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset |
| CFPB Consumer Complaint Database | 명시 없음(미국 정부 공개 자료) | 이슈 범주(범주만). 출처는 공개 필드 정의 문서이며 내려받은 압축 파일의 내용이 아니다 | https://cfpb.github.io/api/ccdb/fields.html |
| 한국소비자원·공정거래위원회 공개 자료(공공데이터포털) | 이용허락범위 제한 없음 | 청약철회, 중도 해지 위약금, 자동갱신 고지 같은 상황 범주(범주만). 자유서술 칸은 쓰지 않는다 | https://www.data.go.kr |
| LLMail-Inject Challenge (Microsoft) | MIT | 인젝션 기법 계열(기법 계열만). 원문 공격 문장은 모델에도 저장소에도 넣지 않는다 | https://huggingface.co/datasets/microsoft/llmail-inject-challenge |

## 확인 기록

- LLMail-Inject: 2026-11-05에 Hugging Face 데이터셋 카드(위 주소)의 메타데이터를 확인했고 `license: mit`로 표시된다. 라이선스 확인일 2026-11-05.

## 원칙

- 범주만, 기법 계열만 쓰는 데이터셋의 문장은 어떤 시나리오 문장에도 옮기지 않는다.
- 비상업 조건의 데이터는 쓰지 않는다. AI Hub 데이터는 쓰지 않는다.
- 시나리오의 고객 이름과 회사는 모두 가상이다.
- 시나리오 레코드의 `source` 칸은 이 표의 라이선스와 쓰임 안에서만 값을 가진다(`scripts/sim/scenarios.js`의 허용 표).

## 저작자 표시

- τ-bench: Copyright (c) 2024 Sierra. τ²-bench: Copyright (c) 2025 Sierra Research. MIT License.
- ABCD: Copyright (c) 2021 ASAPP Research. MIT License. Chen et al., "Action-Based Conversations Dataset: A Corpus for Building More In-Depth Task-Oriented Dialogue Systems", NAACL 2021.
- Banking77: Casanueva et al., "Efficient Intent Detection with Dual Sentence Encoders", 2020 (arXiv:2003.04807). CC BY 4.0.
- CLINC150: Larson et al., "An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction", EMNLP 2019. CC BY 3.0.
- Bitext: (c) Bitext Innovations. CDLA-Sharing-1.0.
- LLMail-Inject: Microsoft, LLMail-Inject Challenge. MIT License.
