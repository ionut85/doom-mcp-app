# Directing Claude by voice

Goal: say "go through the door on the left and kill the imp" out loud and have Claude turn it into game actions.

There are three ways to get there. They differ in what we control and what the host decides.

## 1. Dictate into the Claude composer (works today)

The Claude apps on desktop and mobile, and the operating system's own dictation, turn speech into text in the message box. To Claude this is just a typed message, so it needs nothing from us.

- **Status:** works in any host, nothing to build. This is the fallback for the demo.
- **Demo tip:** dictate short, concrete commands such as "turn left and open the door" or "shoot the imp, then back off". Claude handles them best as a few tool calls each.

## 2. Push-to-talk inside the viewer (built, needs a host test)

The inline viewer has a **Tell Claude** box under the caption log, shown only when the host accepts messages from the app (MCP Apps `message` capability).

- **Typing** an instruction and pressing Enter or Send posts it into the conversation as the user's message through `app.sendMessage()`. Claude then acts on it like any chat message.
- **The microphone button** (🎤) appears when the browser has speech recognition (Web Speech API: Chrome, Edge, Safari). Click it, speak, and the text is sent when you stop talking.
- **Microphone permission.** The viewer resource asks the host for the microphone through `_meta.ui.permissions.microphone`. The MCP Apps spec lets hosts refuse it. If they do, the button shows "The microphone isn't available here. Type instead." and typing still works.
- **Privacy.** Chrome's speech recognition sends the audio to Google's speech service, while Safari can recognize on-device. Say this if you demo it.

**Verified locally** in `/dev/host`, our own MCP Apps test host: typing in the viewer delivers the text to the host as a user chat message. Two bugs were fixed along the way:
- sandboxed iframes without `allow-forms` never fire a form's `submit` event, so the box uses plain click and Enter handlers;
- the box is hidden when the host doesn't advertise `message`.

**Not verified:**
- whether claude.ai grants the microphone to app iframes;
- whether it shows app-sent messages as user turns that Claude answers.

**How to test in claude.ai:**
1. Start a game ("Start a game of DOOM"), and in the viewer type `turn around and walk forward` and press Enter.
   - Expected: the message appears in the chat as yours and Claude makes the moves.
   - If nothing happens, open **Diagnostics** in the viewer and check `talk.hostAcceptsMessages` and `messageError`.
2. Click 🎤 and say "open the door in front of you".
   - Expected: the browser asks for microphone access (or the host does), the words appear in the box, and they're sent when you stop.
   - Diagnostics show `speechError` if the host or browser refuses.
3. Repeat on the desktop app and on mobile. Mobile web views are the most likely to refuse the microphone.

## 3. Claude's own voice mode (unknown, test manually)

Claude's voice conversation mode may or may not call connector tools and render MCP Apps. If it does, this is the most natural demo: talk to Claude and watch it play. We can't control or test it from the server side.

**How to test:**
1. Enable the DOOM connector.
2. Start a voice conversation and say "Start a game of DOOM and walk forward".
3. See whether tool calls happen and whether the viewer appears.

Record the result here.

## Recommendation for the talk

- **Lead with dictation into the composer.** It's reliable everywhere.
- **Show the viewer's push-to-talk** as the "inside the game" version once it's confirmed in the host you'll present with.
- **Keep the typed Tell Claude box** as the backup, since it works wherever the host accepts app messages.
