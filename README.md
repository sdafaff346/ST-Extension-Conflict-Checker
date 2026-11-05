# 확장 충돌 검사기 (Extension Conflict Checker)

설치하려는 확장의 GitHub 링크를 넣으면 지금 설치된 확장들과 코드를 비교해 충돌 가능성을 알려줍니다. 설치된 확장끼리 전체 검사도 됩니다.

## 설치
1. 이 폴더(`ST-Extension-Conflict-Checker`)를 `SillyTavern/data/<사용자>/extensions/` 에 복사
2. ST 새로고침 → 확장 패널 → "확장 충돌 검사기"

## 사용
- 패널에 링크 입력 → **링크 검사** / **설치된 확장 전체 검사**
- 슬래시 명령: `/extconflict` , `/extconflict https://github.com/작성자/확장`

## 검사 항목
| 등급 | 내용 |
|---|---|
| 위험 | 같은 슬래시 명령·매크로·함수 도구·인터셉터 이름, 같은 window 전역 변수, 같은 extension_settings 키, 같은 HTML id, 중복 설치, ST 버전 부족, 의존 확장 없음 |
| 주의 | 같은 대상 몽키패치(fetch, $.fn 등), 같은 단축키, CSS !important 겹침, 이벤트 맨앞/맨뒤 경쟁 |
| 참고 | 둘 다 프롬프트 가로채기, 이미 설치된 같은 확장(버전 비교), 공통 이벤트 다수 |

코드를 읽어서 찾는 "가능성" 검사라 압축(번들)된 확장은 일부를 놓칠 수 있고, 표시돼도 실제로는 괜찮을 수 있어요.
링크 검사는 GitHub(raw.githubusercontent.com, api.github.com)에 접속합니다.
