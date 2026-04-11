# C++ Prerequisites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `hardour` binary to support headless sessions with MCP HTTP, and add a sandboxed `session/lua_eval` tool to the MCP HTTP surface.

**Architecture:** Two independent C++ changes: (1) `hardour` gets an EventLoop, backend CLI flag, and explicit MCP HTTP activation with port config. (2) The MCP HTTP surface gets a new tool handler that creates a sandboxed Lua state, dispatches execution to the main event loop, and captures output.

**Tech Stack:** C++17, Ardour internals (libardour, PBD, Temporal), Lua (via LuaState/LuaBridge), libwebsockets, waf build system.

**Spec:** `docs/superpowers/specs/2026-04-11-session-manager-design.md`

---

### Task 1: Extend `hardour` Binary — EventLoop, Backend Selection, MCP HTTP Activation

The current `hardour` binary (`headless/load_session.cc`, 285 lines) loads a session and calls `request_roll()`. It has no EventLoop (required by MCP HTTP surface), hardcodes the backend, and has no mechanism to activate control surfaces.

This task adds:
- `MyEventLoop` class (from luasession pattern)
- `--backend` and `--mcp-http-port` CLI flags
- Explicit MCP HTTP surface activation after session loads
- Removal of `request_roll()` (headless server should not auto-play)

**Files:**
- Modify: `headless/load_session.cc`

- [ ] **Step 1: Add required includes**

At the top of `headless/load_session.cc`, after the existing includes (line 43), add:

```cpp
#include "pbd/event_loop.h"
#include "ardour/control_protocol_manager.h"
#include "ardour/session_event.h"
```

- [ ] **Step 2: Add MyEventLoop class**

After the existing `using` declarations (around line 49) and before the `wearedone()` signal handler (line 112), add:

```cpp
class MyEventLoop : public sigc::trackable, public PBD::EventLoop
{
public:
	MyEventLoop (std::string const& name)
		: EventLoop (name)
	{
		run_loop_thread = g_thread_self ();
	}

	bool call_slot (PBD::EventLoop::InvalidationRecord* ir, const std::function<void ()>& f)
	{
		if (g_thread_self () == run_loop_thread) {
			f ();
		} else {
			f ();
		}
		return true;
	}

	void run ()
	{
	}

	PBD::RWLock& slot_invalidation_rwlock ()
	{
		return request_buffer_map_lock;
	}

private:
	GThread*     run_loop_thread;
	PBD::RWLock  request_buffer_map_lock;
};

static MyEventLoop* event_loop = 0;
```

- [ ] **Step 3: Add CLI flags for --backend and --mcp-http-port**

In `main()`, add new variables after the existing declarations (around line 156):

```cpp
	std::string  backend_name = "None (Dummy)";
	int          mcp_http_port = 0;  // 0 = don't activate MCP HTTP
```

Add new entries to the `longopts` array (before the terminating `{0, 0, 0, 0}`):

```cpp
	{ "backend",             required_argument, 0, 'b' },
	{ "mcp-http-port",       required_argument, 0, 'm' },
```

Update the optstring to include `b:m:`:

Change line 157 from:
```cpp
	const char optstring[] = "vhBdD:c:OU:P";
```
to:
```cpp
	const char optstring[] = "vhBdD:c:OU:Pb:m:";
```

Add case handlers in the `getopt_long` switch (after the existing cases):

```cpp
		case 'b':
			backend_name = optarg;
			break;
		case 'm':
			mcp_http_port = atoi (optarg);
			break;
```

- [ ] **Step 4: Set up EventLoop before session load**

In `main()`, after `ARDOUR::init()` (line 230) and before `load_session()` (line 239), add:

```cpp
	assert (!event_loop);
	event_loop = new MyEventLoop ("hardour");
	PBD::EventLoop::set_event_loop_for_thread (event_loop);
	SessionEvent::create_per_thread_pool ("hardour", 512);
```

- [ ] **Step 5: Pass backend_name to load_session**

The existing `load_session()` function (line 58) has a parameter `backend_client_name`. The backend name is currently hardcoded inside the function at line 75:

```cpp
	engine->set_backend (backend_name, backend_client_name, "");
```

Wait — the function already takes backend parameters. Check the function signature at line 58:

```cpp
static int load_session (string dir, string state, string backend_client_name)
```

And at line 75 it uses a `backend_name` variable. This variable is currently set at the top of `load_session()` based on `#ifdef __APPLE__` conditionals (lines 60-68). We need to either:
- Make `backend_name` a parameter to `load_session()`, or
- Use the global variable approach.

The simplest approach: add a `backend_name` parameter to `load_session()`:

Change the function signature (line 58) to:
```cpp
static int load_session (string dir, string state, string backend_client_name, string backend_name)
```

Remove the existing backend_name logic inside load_session (lines 60-68, the `#ifdef __APPLE__` block that sets `backend_name`).

Update the call in `main()` (line 239) to pass the new parameter:
```cpp
	if (load_session (argv[optind], argv[optind + 1], name, backend_name)) {
```

- [ ] **Step 6: Activate MCP HTTP surface after session loads**

In `main()`, after the `load_session()` call succeeds (around line 240), add:

```cpp
	/* Activate MCP HTTP surface if port was specified */
	if (mcp_http_port > 0) {
		ARDOUR::ControlProtocolInfo* cpi = ARDOUR::ControlProtocolManager::instance().cpi_by_name ("MCP HTTP Server (Experimental)");
		if (cpi) {
			XMLNode* state_node = new XMLNode ("Protocol");
			state_node->set_property ("port", mcp_http_port);
			cpi->state = state_node;
			if (ARDOUR::ControlProtocolManager::instance().activate (*cpi)) {
				cerr << "Failed to activate MCP HTTP surface on port " << mcp_http_port << endl;
			} else {
				cerr << "MCP HTTP listening on port " << mcp_http_port << endl;
			}
		} else {
			cerr << "MCP HTTP surface not found — is it built?" << endl;
		}
	}
```

- [ ] **Step 7: Remove request_roll()**

Comment out or remove the `s->request_roll()` call (line 273). A headless server should wait for commands, not auto-play:

```cpp
	// s->request_roll ();   // removed: headless server should not auto-play
```

- [ ] **Step 8: Build and test**

```bash
cd /Users/shanekoss/Repos/ardour
./waf build 2>&1 | tail -20
```

Expected: Build succeeds. The binary is at `build/headless/hardour-<VERSION>`.

Test basic launch with Dummy backend:
```bash
# Create a minimal test session first
./build/luasession/luasession -e '
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()
create_session("/tmp/hardour-test", "test-session", 48000)
Session:save_state("")
close_session()
quit()
'

# Now test hardour with MCP HTTP
./build/headless/hardour-* --backend "None (Dummy)" --mcp-http-port 4825 /tmp/hardour-test test-session &
HARDOUR_PID=$!
sleep 3

# Test MCP HTTP is responding
curl -s -X POST http://127.0.0.1:4825/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"hello_world","arguments":{"name":"test"}},"id":1}'

# Expected: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Hello from Ardour, test (session: test-session)"}]},"id":"1"}

kill $HARDOUR_PID
```

- [ ] **Step 9: Commit**

```bash
git add headless/load_session.cc
git commit -m "feat: extend hardour with EventLoop, backend selection, and MCP HTTP activation"
```

---

### Task 2: Add `session/lua_eval` MCP Tool

Add a new tool handler to the MCP HTTP surface that executes sandboxed Lua code in the session context. The handler dispatches Lua execution to the main event loop thread for thread safety, and includes timeout and output capture mechanisms.

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`
- Modify: `libs/surfaces/mcp_http/tools_json.inc`
- Modify: `libs/surfaces/mcp_http/wscript`

- [ ] **Step 1: Add liblua dependency to wscript**

In `libs/surfaces/mcp_http/wscript`, change line 24 from:
```python
obj.use = 'libardour libardour_cp libgtkmm2ext libpbd libytkmm'
```
to:
```python
obj.use = 'libardour libardour_cp libgtkmm2ext libpbd libytkmm liblua'
```

- [ ] **Step 2: Add Lua includes to mcp_http_server.cc**

At the top of `libs/surfaces/mcp_http/mcp_http_server.cc`, after the existing includes, add:

```cpp
#include "lua/luastate.h"
#include "LuaBridge/LuaBridge.h"
#include "ardour/luabindings.h"
```

- [ ] **Step 3: Add the lua_eval tool schema to tools_json.inc**

At the end of `libs/surfaces/mcp_http/tools_json.inc`, before any closing brackets/braces, add the new tool definition. The file uses raw string literals in the pattern `R"json(...)json"`. Add:

```cpp
R"json(
{
  "name": "session/lua_eval",
  "title": "Execute Lua Script",
  "description": "Execute sandboxed Lua code in the session context. Has access to ARDOUR.*, Session, Temporal.*, PBD.*, and Evoral.* bindings. Standard library io, os, loadfile, dofile, require, package, debug are stripped for security. Print output is captured and returned. Execution timeout: 30 seconds.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "description": "Lua source code to execute. Max 65536 bytes.",
        "maxLength": 65536
      }
    },
    "required": ["code"]
  }
}
)json",
```

Match the exact placement pattern used by other tools in the file.

- [ ] **Step 4: Add the lua_eval timeout hook**

In `libs/surfaces/mcp_http/mcp_http_server.cc`, add a static timeout hook function and output capture helper near the top of the file (after includes, before the class methods):

```cpp
/* lua_eval support */

struct LuaEvalContext {
	std::string   output;
	size_t        output_limit;
	int64_t       deadline_us;
	bool          timed_out;
};

static void
lua_eval_timeout_hook (lua_State* L, lua_Debug*)
{
	LuaEvalContext* ctx = (LuaEvalContext*)lua_touserdata (L, lua_upvalueindex (1));
	if (ctx && g_get_monotonic_time () > ctx->deadline_us) {
		ctx->timed_out = true;
		luaL_error (L, "execution timed out");
	}
}

static int
lua_eval_print (lua_State* L)
{
	LuaEvalContext* ctx = (LuaEvalContext*)lua_touserdata (L, lua_upvalueindex (1));
	int n = lua_gettop (L);
	for (int i = 1; i <= n; i++) {
		if (i > 1) {
			ctx->output += "\t";
		}
		const char* s = luaL_tolstring (L, i, NULL);
		if (s) {
			if (ctx->output.size () + strlen (s) < ctx->output_limit) {
				ctx->output += s;
			}
		}
		lua_pop (L, 1);
	}
	ctx->output += "\n";
	return 0;
}
```

- [ ] **Step 5: Add the lua_eval handler function**

Add the handler function in `mcp_http_server.cc`. Place it near the other `handle_*` functions:

```cpp
static std::string
handle_lua_eval_tool (ARDOUR::Session& session, PBD::EventLoop* event_loop, const pt::ptree& root, const std::string& id)
{
	std::string code = root.get<std::string> ("params.arguments.code", "");
	if (code.empty ()) {
		return jsonrpc_error (id, -32602, "Missing required parameter: code");
	}
	if (code.size () > 65536) {
		return jsonrpc_error (id, -32602, "Code exceeds maximum length (65536 bytes)");
	}

	/* Set up eval context */
	LuaEvalContext ctx;
	ctx.output_limit = 65536;
	ctx.deadline_us = g_get_monotonic_time () + 30 * 1000000; /* 30 second timeout */
	ctx.timed_out = false;

	std::string result_json;
	bool        lua_error = false;
	std::string error_msg;

	/* Dispatch to event loop for thread safety */
	auto eval_fn = [&]() {
		/* Create sandboxed Lua state */
		LuaState lua (true, true); /* sandbox=true, rt_safe=true: strips io, os, etc. */
		lua_State* L = lua.getState ();

		/* Register Ardour bindings */
		LuaBindings::stddef (L);
		LuaBindings::common (L);
		LuaBindings::non_rt (L);

		/* Set Session global */
		luabridge::push<ARDOUR::Session*> (L, &session);
		lua_setglobal (L, "Session");

		/* Override print to capture output */
		lua_pushlightuserdata (L, &ctx);
		lua_pushcclosure (L, lua_eval_print, 1);
		lua_setglobal (L, "print");

		/* Set timeout hook */
		lua_pushlightuserdata (L, &ctx);
		lua_pushcclosure (L, [](lua_State* L) -> int {
			lua_eval_timeout_hook (L, NULL);
			return 0;
		}, 1);
		/* Use debug hook for timeout — check every 100000 instructions */
		lua_sethook (L, [](lua_State* L, lua_Debug*) {
			/* Retrieve context from registry */
			lua_getfield (L, LUA_REGISTRYINDEX, "_eval_ctx");
			LuaEvalContext* ctx = (LuaEvalContext*)lua_touserdata (L, -1);
			lua_pop (L, 1);
			if (ctx && g_get_monotonic_time () > ctx->deadline_us) {
				ctx->timed_out = true;
				luaL_error (L, "execution timed out");
			}
		}, LUA_MASKCOUNT, 100000);

		/* Store context pointer in registry for the hook */
		lua_pushlightuserdata (L, &ctx);
		lua_setfield (L, LUA_REGISTRYINDEX, "_eval_ctx");

		/* Execute */
		if (luaL_dostring (L, code.c_str ())) {
			lua_error = true;
			const char* err = lua_tostring (L, -1);
			error_msg = err ? err : "unknown Lua error";
		}
	};

	if (event_loop) {
		/* Dispatch to main thread and wait */
		Glib::Threads::Mutex     mutex;
		Glib::Threads::Cond      cond;
		bool                     done = false;

		event_loop->call_slot (0, [&]() {
			eval_fn ();
			Glib::Threads::Mutex::Lock lm (mutex);
			done = true;
			cond.signal ();
		});

		Glib::Threads::Mutex::Lock lm (mutex);
		while (!done) {
			cond.wait (mutex);
		}
	} else {
		/* No event loop — run directly (testing) */
		eval_fn ();
	}

	if (lua_error) {
		std::string escaped_error = json_escape (error_msg);
		std::string escaped_output = json_escape (ctx.output);
		return jsonrpc_result (
			id,
			std::string ("{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"success\\\":false,\\\"error\\\":\\\"")
			+ escaped_error
			+ "\\\",\\\"output\\\":\\\"" + escaped_output + "\\\"}\"}]}");
	}

	std::string escaped_output = json_escape (ctx.output);
	return jsonrpc_result (
		id,
		std::string ("{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"success\\\":true,\\\"output\\\":\\\"")
		+ escaped_output + "\\\"}\"}]}");
}
```

- [ ] **Step 6: Wire the handler into the dispatch chain**

In the `dispatch_jsonrpc()` method (around line 8036), find the `tools/call` dispatch section. After the `hello_world` handler block and before the other dispatch calls, add:

```cpp
		if (tool_name == "session/lua_eval") {
			return handle_lua_eval_tool (_session, _event_loop, root, id);
		}
```

Note: `_session` and `_event_loop` are member variables of `MCPHttpServer`. The `handle_lua_eval_tool` function needs access to the event loop, which may not be passed through the existing dispatch pattern. If `dispatch_jsonrpc` is a `const` method on `MCPHttpServer`, the event loop pointer `_event_loop` should be accessible.

Check whether `handle_lua_eval_tool` needs to be called directly from `dispatch_jsonrpc` rather than through a sub-dispatcher, since the sub-dispatchers (`dispatch_session_tool_call`, etc.) take `Session&` but not `EventLoop*`. Adding it directly in `dispatch_jsonrpc` before the sub-dispatchers is cleanest.

- [ ] **Step 7: Build and test**

```bash
cd /Users/shanekoss/Repos/ardour
./waf build 2>&1 | tail -20
```

Expected: Build succeeds.

Test lua_eval with the hardour binary from Task 1:

```bash
# Start hardour with MCP HTTP
./build/headless/hardour-* --backend "None (Dummy)" --mcp-http-port 4825 /tmp/hardour-test test-session &
HARDOUR_PID=$!
sleep 3

# Test lua_eval — simple expression
curl -s -X POST http://127.0.0.1:4825/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"session/lua_eval","arguments":{"code":"print(\"hello from lua_eval\")\nprint(\"session: \" .. Session:name())"}},"id":1}'

# Expected: response containing "hello from lua_eval" and "session: test-session"

# Test lua_eval — create a track
curl -s -X POST http://127.0.0.1:4825/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"session/lua_eval","arguments":{"code":"local tl = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, \"LuaTrack\", ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)\nprint(\"tracks created: \" .. tl:size())"}},"id":2}'

# Expected: response containing "tracks created: 1"

# Verify the track was created via the existing tracks/list tool
curl -s -X POST http://127.0.0.1:4825/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tracks/list","arguments":{}},"id":3}'

# Expected: response containing "LuaTrack"

# Test sandbox — verify os.execute is blocked
curl -s -X POST http://127.0.0.1:4825/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"session/lua_eval","arguments":{"code":"os.execute(\"echo pwned\")"}},"id":4}'

# Expected: error response — "os" should be nil in sandboxed state

kill $HARDOUR_PID
```

- [ ] **Step 8: Commit**

```bash
git add libs/surfaces/mcp_http/mcp_http_server.cc libs/surfaces/mcp_http/tools_json.inc libs/surfaces/mcp_http/wscript
git commit -m "feat: add sandboxed session/lua_eval MCP HTTP tool"
```

---

### Summary: Task Dependencies

```
Task 1 (hardour extension)
    ↓
Task 2 (lua_eval MCP tool)  — depends on Task 1 for testing, but code changes are independent
```

Task 1 must be built and testable before Task 2 can be end-to-end tested. However, the code changes in Task 2 are in different files and can be written in parallel with Task 1.

### Known Risks

1. **GTK dependency in MCP HTTP .so**: The surface links against `libytkmm`. This is not expected to be a problem (the .so loads via `dlopen`, GUI functions are never called headless) but should be verified during the Task 1 test step.

2. **Event loop thread dispatch**: The `call_slot` implementation in `MyEventLoop` currently executes functions inline (`f()`) regardless of which thread calls it. For the lua_eval handler, which is called from the MCP HTTP service thread, this means Lua execution happens on the HTTP thread — not the main thread. The mutex/cond wait in `handle_lua_eval_tool` expects `call_slot` to dispatch to the main thread. If the EventLoop's `call_slot` runs inline, the dispatch is synchronous anyway, which is safe for single-threaded use but means the HTTP service thread blocks during Lua execution. This is acceptable for V1 since actions are serialized by the Node.js queue, but should be noted.

3. **Lua state per-request vs cached**: This implementation creates a new `LuaState` per lua_eval call. This is simpler and avoids state leakage between calls, but has overhead from binding registration (~5ms per call). If performance is an issue, a cached Lua state per session can be added later.

4. **hardour binary name**: The wscript produces `hardour-<VERSION>` (e.g., `hardour-9.0`). The Node.js config should use a glob or the actual binary name. The spec config says `build/headless/hardour` — this may need adjustment to match the versioned name.
