# 다이어그램 색인

각 다이어그램은 JSON 원본과, 그 원본에서 만든 단독 HTML 한 쌍이다. HTML은 브라우저로 바로 열 수 있고, 고칠 때는 JSON을 고친 뒤 HTML을 다시 만든다. 다이어그램에 나오는 상태·코드 값의 뜻은 [`../states.md`](../states.md)에 모았다.

| 다이어그램 | 답하는 질문 | 원본 |
|---|---|---|
| [루프 개요](cs-agent-overview.html) | 문의 한 통이 접수 Agent·답장 Agent·검수 Agent·인계 Agent와 두 번의 판단을 거쳐 어떤 결과로 끝나는가? | [JSON](cs-agent-overview.architecture.json) |
| [시스템 구성](cs-agent-system.html) | 어떤 프로세스와 모듈이 있고, 서로 무엇을 주고받는가? | [JSON](cs-agent-system.architecture.json) |
| [모듈 아키텍처](cs-agent-architecture.html) | 판단·기록·화면을 맡은 서버 모듈은 어떻게 나뉘고, CRM 문서는 어디서 만들어지는가? | [JSON](cs-agent-architecture.architecture.json) |
| [수신 경로](cs-agent-intake.html) | 메일은 어느 입구로 들어와 케이스가 되고, 담당자 명령은 어디로 이어지는가? | [JSON](cs-agent-intake.dataflow.json) |
| [한 회차 루프](cs-agent-loop.html) | 메시지 하나에 대해 1차 거르기부터 실행까지 어떤 단계와 판단 규칙을 지나는가? | [JSON](cs-agent-loop.workflow.json) |
| [E2E](cs-agent-e2e.html) | 고객 메일부터 담당자 승인, 발송, 고객 회신까지 한 케이스가 끝까지 어떻게 흐르는가? | [JSON](cs-agent-e2e.workflow.json) |
| [케이스 상태](cs-agent-case-lifecycle.html) | 케이스 상태는 무엇이 있고, 어떤 사건이 어느 상태로 옮기는가? | [JSON](cs-agent-case-lifecycle.lifecycle.json) |
| [초안 상태](cs-agent-draft-lifecycle.html) | 답장 초안은 만들어진 뒤 어떤 상태를 거쳐 나가거나 버려지는가? | [JSON](cs-agent-draft-lifecycle.lifecycle.json) |
| [데이터 모델](cs-agent-data-model.html) | 어떤 테이블에 무엇이 저장되고, 테이블끼리 어떻게 이어지는가? | [JSON](cs-agent-data-model.architecture.json) |
