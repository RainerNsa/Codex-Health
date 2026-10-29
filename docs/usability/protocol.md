# Usability protocol (SPEC §13 rows 7 and 11; dev-alignment 2.10)

Status: written 2026-10-29 for session 1 (M2, manual fact entry). Sessions 2 to 4 reuse it at M4, M6 and M8
with the tasks extended to the screens that exist by then.

**Result to date: §15 standard 7 not met, standard 11 comprehension probe not met: no admissions staff
available (F6).** A session run with anyone who is not currently doing SNF admissions screening is recorded as a
dry run, never as a pass.

## 1. Who

- **Tester**: a person currently doing admissions screening at a skilled nursing facility (SPEC §13). The
  professionals recruited under F6 qualify only if they do.
- **Cohort**: one tester at M2, M4 and M6; three at M8. A cohort is named before the session and nobody is dropped
  from it afterwards. The standard passes only when **every** tester in the cohort passes every task.
- **Facilitator**: reads each task aloud once, starts and stops the clock, and says nothing else.
- **Observer** (optional): records; never speaks to the tester.

## 2. Assistance (fixed wording, SPEC §13)

Any communication to the tester during a task from anyone present, other than reading the task aloud, is
assistance and fails that task. Answering a question, pointing at a control, or explaining an error all count.
A tester who abandons a task, or exceeds its time cap, fails it. The session is recorded (screen and audio, no
camera). The tester, not the facilitator, signs the assistance log at the end.

## 3. Setup

- The local build from `docs/local-development.md`: API and web on the facilitator's machine, synthetic seed
  loaded, browser open on the form with "ZZTEST Reviewer" selected.
- The tester gets the printed vignette in section 4 and nothing else. No real patient information is used,
  discussed or written down at any point; if the tester starts describing a real patient, the facilitator stops
  the session.
- Before starting: consent to recording; "we are testing the screen, not you; if something is confusing, that is
  what we need to find."

## 4. Synthetic vignette (printed for the tester)

> **ZZTEST Patient, referral from ZZTEST General Hospital.** Discharge planned in two days.
> - Ventilator: the hospital liaison says by phone the patient was weaned off the ventilator yesterday.
> - Behaviour: the discharge summary mentions no aggression or behavioural incidents.
> - Therapy: the PT note recommends daily skilled therapy.

Expected outcome after all three facts: **Admit**. The ventilator fact is critical.

## 5. Tasks (session 1, M2)

Each task has a time cap. The clock starts when the facilitator finishes reading the task.

| # | Task as read aloud | Success when | Cap |
| --- | --- | --- | --- |
| T1 | "Start a new referral for this patient." | A referral is created (status draft) | 2 min |
| T2 | "Record what the liaison told you about the ventilator, and say where it came from." | ventilator use = no, with a note naming the liaison | 3 min |
| T3 | "Record the behaviour and therapy information from the vignette." | recent aggression = no and daily skilled need = yes, each with a note | 4 min |
| T4 | "What does the system recommend, and why?" | Tester states Admit and names the therapy need as the reason | 2 min |
| T5 | "The liaison calls back: the patient is back on the ventilator. Update the record." | ventilator use corrected to yes, with a note; outcome shows Do Not Admit | 3 min |
| T6 | "Is the earlier ventilator answer gone?" | Tester says it is kept on record (a correction does not erase) | 1 min |

## 6. Comprehension probe (§15 standard 11)

After the tasks, the facilitator shows each state once, using the test flag or the reproduction step listed, and
asks: "What happened, and what would you do next?" The answer is scored against the key; every cohort tester must
score every state reachable at that milestone.

| State (SPEC §19) | How to show it at M2 | Answer key: cause / next action |
| --- | --- | --- |
| Error | Save a fact with an empty note | A note is required / add where the information came from |
| Missing information | A new referral with only ventilator = no entered | The recommendation is waiting on facts it needs / enter or request the missing facts listed |
| Override confirmation | Not reachable at M2 (finalize arrives later) | Scored from M6 |
| Loading, processing failure, conflicting information | Not reachable at M2 (no documents or pipeline) | Scored from M4/M5 |
| Read-only refusal | Switch to "ZZTEST Viewer" and open the referral | This user may not see or change patient details / ask a Reviewer or Admin |

## 7. What is recorded (per tester, per task)

| Measure | Source |
| --- | --- |
| Pass / fail, and the reason for a fail | Facilitator sheet |
| Time on task | Facilitator clock; cross-checked against `review.started` / `review.ended` events once the web emits them |
| Assistance events, verbatim | Recording; signed log |
| Errors seen (codes) | API responses; the recording |
| Comprehension score per state | Probe sheet against the key |
| Evidence-view rate per decisive fact before finalize (SPEC §14.1) | Not measurable at M2: manual entry has no page images; from M5 |

Results go into `../ops/decision-log.md` as one row per session: date, milestone, cohort size, tasks passed,
states scored, and every failure in one line. No tester names; tester ids only (T-01, T-02...).

## 8. Sheets

**Facilitator sheet** (one per tester): tester id; date; build commit; for T1-T6: start, stop, pass/fail,
assistance yes/no, note. **Probe sheet**: state, tester's words (paraphrased, no patient details), score
against the key. **Assistance log**: every assistance event with the time; signed by the tester.
