"use strict";

var {
	EMPTY_FUNC,
	identity,
	isFunction,
	isPromise,
	isMonad,
	curry,
	getDeferred,
	continuation,
	runSignal,
	isRunSignal,
	trampoline,
} = require("../lib/util.js");
var Either = require("../either.js");
var IO = require("./io.js");

// curry some public methods
onEvent = curry(onEvent,2);
onceEvent = curry(onceEvent,2);

of.empty = ofEmpty;

var registerHooks = new WeakMap();
const BRAND = {};
const EMPTY = Symbol("empty");
const UNSET = Symbol("unset");
const CLOSED = Symbol("closed");
const NEVER = Symbol("never");
const EMPTY_IO = IO.of();
const IOis = IO.is;
const IO_is = EMPTY_IO._is;
const NeverIOx = defineNeverIOx();

module.exports = Object.assign(IOx,{
	of, pure: of, unit: of, is, do: $do, doEither, onEvent,
	onceEvent, onTimer, merge, zip, fromIO, fromIter, toIter,
	fromObservable, Never: NeverIOx,
});
module.exports.of = of;
module.exports.pure = of;
module.exports.unit = of;
module.exports.is = is;
module.exports.do = $do;
module.exports.doEither = doEither;
module.exports.onEvent = onEvent;
module.exports.onceEvent = onceEvent;
module.exports.onTimer = onTimer;
module.exports.merge = merge;
module.exports.zip = zip;
module.exports.fromIO = fromIO;
module.exports.fromIter = fromIter;
module.exports.toIter = toIter;
module.exports.fromObservable = fromObservable;
module.exports.Never = NeverIOx;


// *****************************************

function IOx(iof,deps = []) {
	if (Array.isArray(deps)) {
		deps = [ ...deps ];
	}
	else {
		deps = [ deps ];
	}

	const TAG = "IOx";
	const origBind = IOx$.bind;
	var currentEnv = UNSET;
	var currentVal = UNSET;
	var waitForDeps;
	var depsComplete;
	var depVals = new WeakMap();
	var latestIOxVals = new WeakMap();
	var ioDepsPending = new WeakSet();
	var chainReturnedIOxs = new WeakSet();
	var listeners;
	var registering = false;
	var runningIOF = false;
	var registered = false;
	var closing = false;
	var collectingDepsStack = 0;

	var io = IO(effect);
	var publicAPI = Object.assign(IOx$,{
		map, chain, flatMap: chain, bind: chain,
		concat, run, stop, close, isClosed, never,
		isNever, toString, _chain_with_IO, _inspect,
		_bind: origBind, _is, [Symbol.toStringTag]: TAG,
	});
	registerHooks.set(publicAPI,[ registerListener, unregisterListener, ]);
	return publicAPI;

	// *****************************************

	// wrapper used only for external re-mapping of
	// name for publicAPI/instance (assignment function)
	function IOx$(v) {
		assign(v);
	}

	// purely for debugging aesthetics
	function toString() {
		return (currentVal === NEVER ?
			NeverIOx.toString() :
			`[function ${this[Symbol.toStringTag] || this.name}]`
		);
	}

	function run(env) {
		if (currentVal === NEVER) {
			return;
		}
		else if (!closing) {
			return (isRunSignal(env) ?
				io.run(env) :
				trampoline(io.run(runSignal(env)))
			);
		}
	}

	function stop() {
		if (currentVal !== NEVER) {
			unregisterWithDeps();
			currentEnv = UNSET;
		}
	}

	function close(signal) {
		if (currentVal === NEVER) {
			return;
		}
		else if (!closing) {
			closing = true;
			stop();

			let cont = continuation(
				() => {
					try {
						return updateCurrentVal(CLOSED,/*drainQueueIfAsync=*/false);
					}
					finally {
						registerHooks.delete(publicAPI);
						ioDepsPending = waitForDeps = depsComplete =
							chainReturnedIOxs = deps = iof = io = publicAPI =
							listeners = null;
					}
				}
			);

			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

	function isClosed() {
		return closing;
	}

	function never() {
		if (!closing && currentVal !== NEVER) {
			assign(NEVER);
		}
	}

	function isNever() {
		return (!closing && currentVal === NEVER);
	}

	function assign(v) {
		if (!closing && currentVal !== NEVER) {
			unregisterWithDeps();
			deps = currentEnv = iof = null;
			trampoline(
				updateCurrentVal(v,/*drainQueueIfAsync=*/false)
			);
		}
	}

	function map(fn) {
		return (
			// IOx already marked as never?
			currentVal === NEVER ?
				// short-circuit out to the no-op dead IOx
				NeverIOx :

				// otherwise, run the map normally
				IOx((env,publicAPIv) => fn(publicAPIv),[ publicAPI, ])
		);
	}

	function chain(fn) {
		// IOx already marked as never?
		if (currentVal === NEVER) {
			// short-circuit out to the no-op dead IOx
			return NeverIOx;
		}

		// outer-chained IOx instance will automatically
		// close if the parent IOx closes
		var outerChainedIOx = IOx((env,publicAPIv) => {
			var res = fn(publicAPIv);

			return (isPromise(res) ?
				// trampoline() here unwraps the continuation
				// immediately, because we're already in an
				// async microtask from the promise
				res.then(iox => trampoline(handle(iox,env))) :

				handle(res,env)
			);
		},[ publicAPI, ]);

		return outerChainedIOx;

		// **************************************

		function handle(returnedIOx,env) {
			if (
				// has the *parent* IOx now become a "never"?
				currentVal === NEVER ||

				// were we returned a "never" IOx?
				returnedIOx === NeverIOx ||
				(is(returnedIOx) && returnedIOx.isNever())
			) {
				// just ignore the IOx since it's never
				// going to give us anything
				return getDeferred().pr;
			}

			// is the *returned* IOx already closed?
			var checkRes = checkClosedIOx(returnedIOx);
			if (checkRes !== undefined) {
				return checkRes;
			}

			if (
				// returned value is a valid IOx instance to chain
				// with?
				is(returnedIOx) && registerHooks.has(returnedIOx) &&

				// first time this *parent* IOx has seen this
				// *returned* IOx?
				//
				// note: also, *parent* IOx must still be open!
				chainReturnedIOxs && !chainReturnedIOxs.has(returnedIOx)
			) {
				// *parent* IOx should remember this specific
				// *returned* IOx (to avoid unnecessary listening)
				chainReturnedIOxs.add(returnedIOx);

				// register listener(s) for IOx closings, then run
				// *returned* IOx (if not closed)
				return continuation(
					// internally, register a close-listener for *parent* IOx
					() => registerListener(
						function listener(_,val){
							if (val === NEVER) {
								unregisterListener(listener);
								return;
							}
							else if (
								// *parent* IOx has now closed?
								val === CLOSED &&

								// returned* IOx still defined and
								// not yet closed?
								returnedIOx && !returnedIOx.isClosed()
							) {
								unregisterListener(listener);

								// close *returned* IOx (for memory cleanup)
								return continuation(
									() => returnedIOx.close(runSignal()),
									cleanup
								);
							}
						},
						currentEnv !== UNSET ? currentEnv : env
					),

					() => {
						// note: *returned* IOx must still be open here
						//
						// register a close/never-listener against *returned* IOx
						var [ regListener, unregListener, ] = registerHooks.get(returnedIOx);
						return continuation(
							() => regListener(
								function listener(_,val){
									if (val === NEVER) {
										unregListener(listener);
										return;
									}
									else if (
										// *returned* IOx has now closed?
										val === CLOSED &&

										// *outer-chained* IOx still defined and
										// not yet closed?
										outerChainedIOx && !outerChainedIOx.isClosed()
									) {
										unregListener(listener);

										// close *outer-chained* IOx (for memory
										// cleanup)
										return continuation(
											() => outerChainedIOx.close(runSignal()),
											cleanup
										);
									}
								},
								currentEnv !== UNSET ? currentEnv : env
							),

							runReturnedIO
						);
					}
				);
			}

			// if we get here, run the *returned* IO/IOx directly
			// (no need for cleanup)
			return runReturnedIO();

			// ******************************************

			// runner for *returned* (assumed) IO/IOx
			function runReturnedIO() {
				// note: if you don't return an IO/IOx to the
				// `chain(fn)` function, as required by the
				// implied type signature of `chain(..)`, this
				// line will throw as we try to `run(..)` the
				// expected IO/IOx
				return returnedIOx.run(runSignal(env));
			}

			function checkClosedIOx(iox) {
				if (
					isClosedIOx(iox) &&

					// *outer-chained* IOx still defined but not yet
					// closed?
					outerChainedIOx && !outerChainedIOx.isClosed()
				) {
					// close *outer-chained* IOx and bail
					return continuation(
						() => outerChainedIOx.close(runSignal()),
						cleanup
					);
				}
			}

			// clean-up closures for better GC
			function cleanup() {
				if (chainReturnedIOxs && returnedIOx) {
					chainReturnedIOxs.delete(returnedIOx);
				}
				outerChainedIOx = returnedIOx = null;
			}
		}
	}

	function concat(m) {
		return (
			// IOx already marked as never?
			currentVal === NEVER ?
				// short-circuit out to the no-op dead IOx
				NeverIOx :

				// otherwise, run the concat normally
				IOx((env,res1) => continuation(
					// note: if you don't provide an IO/IOx
					// monad to `concat(m)`, as the implied
					// type signature requires, this line will
					// throw as we try to `run(..)` the expected
					// IO/IOx
					() => m.run(runSignal(env)),

					res2 => (isPromise(res2) ?
						res2.then(v2 => res1.concat(v2)) :
						res1.concat(res2)
					)
				),[ publicAPI, ])
		);
	}

	function haveDeps() {
		return Array.isArray(deps) && deps.length > 0;
	}

	function haveIOxDeps() {
		if (haveDeps()) {
			return deps.some(is);
		}
	}

	function isClosedIOx(v) {
		return is(v) && v.isClosed();
	}

	function haveQueuedIOxDepVals() {
		if (haveDeps()) {
			for (let dep of deps) {
				if (is(dep)) {
					let depv = depVals.get(dep);
					if (depv && depv.length > 1) {
						return true;
					}
				}
			}
		}
		return false;
	}

	function discardCurrentDepVals() {
		if (haveDeps()) {
			// remove all the current dep values from their
			// respective dep-value queues
			for (let dep of deps) {
				removeDepVal(dep);
				ioDepsPending.delete(dep);
			}
		}
	}

	function discardCurrentIOxDepVals() {
		/* istanbul ignore else */
		if (haveDeps()) {
			// remove all the current IOx dep values from
			// their respective dep-value queues
			for (let dep of deps) {
				if (is(dep)) {
					removeDepVal(dep);
				}
			}
		}
	}

	function discardCurrentIODepVals() {
		if (haveDeps()) {
			// remove all the current IO dep values from
			// their respective dep-value queues
			for (let dep of deps) {
				if (IOis(dep) && !is(dep)) {
					removeDepVal(dep);
				}
			}
		}
	}

	function effect(env) {
		// are we still open and have a valid IOF
		// to execute?
		if (!closing && isFunction(iof)) {
			var cont = continuation();

			// need to register?
			if (!(registering || registered)) {
				cont.push(() => registerWithDeps(env));
			}

			cont.push(() => execIOF(env));

			return cont;
		}
		else {
			/* istanbul ignore else */
			if (![ UNSET, CLOSED, ].includes(currentVal)) {
				return currentVal;
			}
		}

		// note: really shouldn't get here
	}

	function execIOF(env) {
		return (!runningIOF ?
			checkDepsAndExecute(/*curVal=*/UNSET,/*allowIOxCache=*/true) :
			undefined
		);

		// ******************************************

		function checkDepsAndExecute(curVal,allowIOxCache) {
			// this IOx already marked as "never"?
			if (currentVal === NEVER) {
				return getDeferred().pr;
			}

			var dv;
			runningIOF = true;

			// are we still open and have an IOF to exec?
			if (!closing && iof) {
				currentEnv = env;
				dv = collectDepVals(env,allowIOxCache);
			}

			// no set of collected deps values was found?
			if (!dv) {
				try {
					if (curVal !== UNSET) {
						return curVal;
					}
					else {
						if (!waitForDeps) {
							({ pr: waitForDeps, next: depsComplete, } = getDeferred());
						}
						return waitForDeps;
					}
				}
				finally {
					discardCurrentIODepVals();
					runningIOF = false;
				}
			}
			// any of the dependencies a "never" IOx?
			else if (dv === NEVER) {
				// skip executing IOF and just commit
				// a "never" update of this IOx
				return commitIOFResult(NEVER,UNSET);
			}
			else if (
				// all dependencies are now closed?
				dv === CLOSED ||
				// already closed (when registering with deps)?
				!iof
			) {
				try {
					return (
						(curVal !== UNSET ? curVal : undefined) ||
						waitForDeps ||
						getDeferred().pr
					);
				}
				finally {
					close();
					runningIOF = false;
				}
			}

			// if we get here, we have a complete set of dep
			// values (if any) to evaluate the IOx with
			return continuation(
				() => iof(currentEnv,...dv),
				iofRes => commitIOFResult(iofRes,curVal)
			);
		}

		function commitIOFResult(iofRes,curVal) {
			// marked as 'never' during IOF execution?
			if (currentVal === NEVER) {
				runningIOF = false;
				return;
			}
			// was the result of the IOx evaluation non-empty?
			else if (!closing && iofRes !== EMPTY) {
				return continuation(
					// save the current IOx value, either sync or async
					() => updateCurrentVal(iofRes,/*drainQueueIfAsync=*/haveQueuedIOxDepVals()),

					settleUpdate
				);
			}
			// otherwise, nothing else to evaluate, so bail
			else {
				try {
					return (
						![ UNSET, CLOSED, NEVER ].includes(curVal) ? curVal : undefined
					);
				}
				finally {
					discardCurrentIODepVals();
					runningIOF = false;
				}
			}
		}

		function settleUpdate(updateRes) {
			// was the update of the IOx value synchronous,
			// and are there IOx deps (which may have queued
			// up more values that need to be processed)?
			if (!isPromise(updateRes) && haveIOxDeps()) {
				// note: discards IOx dep vals, but preserves
				// any cached IO dep vals, as there's no reason
				// to re-evaluate standard IOs during a synchronous
				// draining of queued dep values
				discardCurrentIOxDepVals();

				// continue the "loop" to re-check the collected
				// deps values to see if this IOx is ready to be
				// re-evaluated
				return checkDepsAndExecute(/*curVal=*/updateRes,/*allowIOxCache=*/false);
			}
			// whether the update was asynchronous, or there
			// are no IOx deps to have queued up more dep values,
			// we can now immediately bail on this evaluation of
			// the IOx
			else {
				// nothing else to evaluate for now
				discardCurrentDepVals();

				try {
					if (haveIOxDeps()) {
						// check again to see if any IOx deps are closed?
						// if so, since the current update is asynchronous,
						// just close right away instead of waiting for it
						for (let dep of deps) {
							if (isClosedIOx(dep)) {
								return continuation(
									// force close our IOx
									() => close(runSignal()),

									// return the promise for the current
									// update settlement
									() => updateRes
								);
							}
						}
					}

					// if we get here, no IOx deps were closed, so just
					// return the promise for the current update
					// settlement
					return updateRes;
				}
				finally {
					discardCurrentIODepVals();
					runningIOF = false;
				}
			}
		}
	}

	function onDepUpdate(dep,newVal) {
		// ignore a straggling dep update after IOx
		// is already marked as a "never"? (should not
		// happen)
		/* istanbul ignore next */
		if (currentVal === NEVER) {
			return;
		}

		if (newVal === NEVER) {
			return updateCurrentVal(NEVER,/*drainQueueIfAsync=*/false);
		}
		else if (newVal === CLOSED) {
			latestIOxVals.delete(dep);
		}
		else {
			setDepVal(dep,newVal);
		}

		if (!registering && !runningIOF) {
			if (currentEnv !== UNSET && newVal !== CLOSED) {
				return publicAPI.run(runSignal(currentEnv));
			}
			else {
				let dv = collectDepVals(undefined,/*allowIOxCache=*/false);
				if (dv === CLOSED) {
					return close(runSignal());
				}
			}
		}
	}

	function setDepVal(dep,val) {
		if (!depVals.has(dep)) {
			depVals.set(dep,[]);
		}

		depVals.get(dep).push(val);

		if (is(dep)) {
			latestIOxVals.set(dep,val);
		}
	}

	function getDepVal(dep) {
		return hasDepVal(dep) ? depVals.get(dep)[0] : undefined;
	}

	function hasDepVal(dep) {
		return (
			depVals.has(dep) &&
			depVals.get(dep).length > 0
		);
	}

	function removeDepVal(dep) {
		if (hasDepVal(dep)) {
			depVals.get(dep).shift();
		}
	}

	function collectDepVals(env,allowIOxCache) {
		// nothing to collect?
		if (!haveDeps()) {
			return [];
		}

		// count how many times this collection is stacked
		// up concurrently
		collectingDepsStack++;

		// collection iterations already in progress?
		if (collectingDepsStack > 1) {
			return false;
		}

		var ret;
		// keep re-collecting the deps as many times as
		// the stack depth indicates
		while (collectingDepsStack > 0) {
			// note: this may be (re)assigned multiple times
			// before return in a subsequent iteration of the
			// collection stack loop
			ret = [];

			// check only for never/closed IOx deps
			for (let dep of deps) {
				if ([ NEVER, NeverIOx ].includes(dep)) {
					// bail early, since any "never" IOxs mean none of
					// the other deps matter
					collectingDepsStack = 0;
					return NEVER;
				}
				else if (
					isClosedIOx(dep) &&
					(
						// not currently in an IOx evaluation loop?
						!runningIOF ||

						// or, no more values in the dep's queue?
						!hasDepVal(dep)
					)
				) {
					// bail early since any closed IOxs mean none of
					// the other deps matter
					collectingDepsStack = 0;
					return CLOSED;
				}
			}

			for (let dep of deps) {
				// dep is a valid IOx?
				if (is(dep)) {
					// note: all IOx deps are either still open, or even
					// if never/closed, they at least have remaining
					// queued value(s)
					let depVal = (
						hasDepVal(dep) ? getDepVal(dep) :
						(allowIOxCache && latestIOxVals.has(dep)) ? latestIOxVals.get(dep) :
						UNSET
					);
					ret.push(depVal);
				}
				// regular IO as dep?
				else if (IOis(dep)) {
					// IO dep already pending?
					if (ioDepsPending && ioDepsPending.has(dep)) {
						ret.push(UNSET);
					}
					else {
						// IO dep already cached?
						if (hasDepVal(dep)) {
							ret.push(getDepVal(dep));
						}
						// otherwise, request the IO value
						else {
							// (re)run the IO to get its results
							let depRes = trampoline(dep.run(
								runSignal(env || (currentEnv !== UNSET ? currentEnv : undefined))
							));

							// IO result not yet ready?
							if (isPromise(depRes)) {
								ioDepsPending.add(dep);
								ret.push(UNSET);
								// wait for the IO result
								depRes.then(v => {
									// still actually waiting on this IO result?
									if (ioDepsPending && ioDepsPending.has(dep)) {
										ioDepsPending.delete(dep);

										// trampoline() here unwraps the continuation
										// immediately, because we're already in an
										// async microtask from the promise
										trampoline(onDepUpdate(dep,v));
									}
								})
								.catch(logUnhandledError);
							}
							else {
								ioDepsPending.delete(dep);
								setDepVal(dep,depRes);
								ret.push(depRes);
							}
						}
					}
				}
				// from an "empty IOx"
				else if (dep === EMPTY) {
					ret.push(UNSET);
				}
				// otherwise, some other kind of fixed (non-IO/x)
				// dep value
				else {
					ret.push(dep);
				}
			}

			// any of the deps not yet complete?
			if (ret.includes(UNSET)) {
				// note: this may be (re)assigned multiple times
				// before return in a subsequent iteration of the
				// collection stack loop
				ret = false;
			}

			// done with this iteration of collection, so decrement
			// stack loop counter
			collectingDepsStack = Math.max(0,collectingDepsStack - 1);
		}

		// did the latest iteration of the collection stack loop
		// produce a complete set of dep values
		if (Array.isArray(ret) && ret.length > 0) {
			return ret;
		}
	}

	function updateCurrentVal(v,drainQueueIfAsync) {
		// still waiting on the resolved value
		// to update with?
		if (isPromise(v)) {
			return v.then(v2 => (
				// trampoline() here unwraps the continuation
				// immediately, because we're already in an
				// async microtask from the promise
				trampoline(handleValue(v2))
			))
			.catch(logUnhandledError);
		}
		else {
			// since this update isn't async, no
			// need to worry about draining the
			// queue
			drainQueueIfAsync = false;

			return handleValue(v);
		}

		// *******************************************

		function handleValue(resV) {
			// IOx has not been marked 'never' during an
			// asynchronous update?
			if (currentVal !== NEVER) {
				currentVal = resV;
			}
			return (
				// any listeners to notify?
				(Array.isArray(listeners) && listeners.length > 0) ?
					notifyListeners(publicAPI,currentVal,listeners) :
					checkIOxQueue()
			);
		}

		function notifyListeners(pAPI,cVal,[ nextListener, ...remainingListeners ]) {
			return continuation(
				() => nextListener(pAPI,cVal),

				(remainingListeners.length > 0 ?
					() => notifyListeners(pAPI,cVal,remainingListeners) :
					checkIOxQueue
				)
			);
		}

		function checkIOxQueue() {
			// need to drain any IOx dep-values queue(s)?
			if (
				currentVal !== NEVER && drainQueueIfAsync &&
				!runningIOF && currentEnv !== UNSET
			) {
				return continuation(
					() => publicAPI.run(runSignal(currentEnv)),
					completeUpdate
				);
			}
			else {
				return completeUpdate();
			}
		}

		function completeUpdate() {
			var depsHaveFinished = () => {
				if (depsComplete) {
					depsComplete(currentVal);
					waitForDeps = depsComplete = null;
				}
			};

			if (currentVal === NEVER) {
				if (!closing && iof) {
					unregisterWithDeps();
					ioDepsPending = waitForDeps = depsComplete =
						chainReturnedIOxs = deps = iof = io = publicAPI =
						listeners = null;
				}
				return undefined;
			}
			else if (currentVal === CLOSED) {
				// not yet fully closed?
				if (io) {
					close();
				}
				depsHaveFinished();
				return undefined;
			}
			// otherwise, updated with valid (non-internal-signal)
			// value
			else {
				depsHaveFinished();
				return currentVal;
			}
		}
	}

	function registerListener(listener,env) {
		if ([ NEVER, CLOSED ].includes(currentVal)) {
			return listener(publicAPI,currentVal);
		}
		else {
			if (!Array.isArray(listeners)) {
				listeners = [ listener, ];
			}
			else {
				listeners.push(listener);
			}

			// haven't run yet?
			if (currentEnv === UNSET) {
				return publicAPI.run(runSignal(env));
			}
			else if (currentVal !== UNSET) {
				// respond with most recent value
				return listener(publicAPI,currentVal);
			}
		}
	}

	function unregisterListener(listener) {
		if (Array.isArray(listeners) && listeners.length > 0) {
			let idx = listeners.findIndex(l => l == listener);
			listeners.splice(idx,1);
		}
	}

	function registerWithDeps(env) {
		// need to subscribe to any deps?
		if (Array.isArray(deps) && deps.length > 0) {
			registering = true;
			return registerDep(deps);
		}
		else {
			registrationComplete();
		}

		// *********************************

		function registerDep([ dep, ...remainingDeps ]) {
			// is the current IOx already marked
			// as a never?
			if (currentVal === NEVER) {
				return registrationComplete();
			}

			// define the next step in the continuation
			var registerNext = (
				remainingDeps.length > 0 ?
					// keep registering the remaining
					// deps
					() => registerDep(remainingDeps) :

					// complete dep registration
					registrationComplete
			);

			// is this dep an IOx instance that
			// we haven't registered with before?
			if (
				is(dep) &&
				registerHooks.has(dep) &&
				!depVals.has(dep)
			) {
				depVals.set(dep,[]);
				let [ regListener, ] = registerHooks.get(dep);
				return continuation(
					() => regListener(onDepUpdate,env),

					registerNext
				);
			}

			// if we get here, dep wasn't an IOx that
			// needed registration, so move on to next
			// step
			return continuation(registerNext);
		}

		function registrationComplete() {
			registering = false;
			registered = true;
		}
	}

	function unregisterWithDeps() {
		registered = false;

		// need to unsubscribe any deps?
		if (haveDeps()) {
			for (let dep of deps) {
				// is this dep an IOx instance?
				if (
					dep &&
					isFunction(dep) &&
					registerHooks.has(dep)
				) {
					depVals.delete(dep);
					if (ioDepsPending) {
						ioDepsPending.delete(dep);
					}
					let [ , unregListener, ] = registerHooks.get(dep);
					unregListener(onDepUpdate);
				}
			}
			depVals = new WeakMap();
			latestIOxVals = new WeakMap();
		}
	}

	// perf optimization "cheat" intended only for `IO.do(..)`:
	//
	// skips evaluating with an enclosing IOx and instead
	// allows current value to either be immediately resolved,
	// or queues up for when the first value resolution of this
	// IOx occurs
	function _chain_with_IO(fn) {
		return (
			// should short-circuit to no-op?
			currentVal === NEVER ? EMPTY_IO :
			(currentVal !== UNSET && currentEnv !== UNSET) ? fn(currentVal) :
			io ? io.chain(fn) :
			fn(undefined)
		);
	}

	function _inspect() {
		if (currentVal === NEVER) {
			return NeverIOx._inspect();
		}
		else if (closing) {
			return `${TAG}(-closed-)`;
		}
		else {
			return `${this[Symbol.toStringTag]}(${
				isMonad(currentVal) && isFunction(currentVal._inspect) ? currentVal._inspect() :
				![ UNSET, CLOSED ].includes(currentVal) ? String(currentVal) :
				(iof.name || "anonymous function")
			})`;
		}
	}

	function _is(br) {
		return !!(br === BRAND || (IO_is(br)));
	}

}

function is(v) {
	return !!(v && isFunction(v._is) && v._is(BRAND));
}

function of(v) {
	if (arguments.length > 0) {
		return IOx(() => v,[]);
	}
	else {
		return ofEmpty();
	}
}

function ofEmpty() {
	return IOx(EMPTY_FUNC,[ EMPTY, ]);
}

function $do(gen,deps,...args) {
	return IOx((env,...deps) => (
		IO.do(gen,...deps,...args).run(env)
	),deps);
}

function doEither(gen,deps,...args) {
	return IOx((env,...deps) => (
		IO.doEither(gen,...deps,...args).run(env)
	),deps);
}

function onEvent(el,evtName,evtOpts = false) {
	var subscribed = false;
	var iox = IOx(effect,[]);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// *****************************************

	function effect() {
		subscribe();
		return EMPTY;
	}

	function subscribe() {
		if (!subscribed && iox) {
			subscribed = true;

			// (lazily) setup event listener
			/* istanbul ignore next */
			if (isFunction(el.addEventListener)) {
				el.addEventListener(evtName,iox,evtOpts);
			}
			else if (isFunction(el.addListener)) {
				el.addListener(evtName,iox);
			}
			else if (isFunction(el.on)) {
				el.on(evtName,iox);
			}
		}
	}

	function unsubscribe() {
		if (subscribed && iox) {
			subscribed = false;

			// remove event listener
			/* istanbul ignore next */
			if (isFunction(el.removeEventListener)) {
				el.removeEventListener(evtName,iox,evtOpts);
			}
			else if (isFunction(el.removeListener)) {
				el.removeListener(evtName,iox);
			}
			else if (isFunction(el.off)) {
				el.off(evtName,iox);
			}
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (_run) {
			subscribe();
			return _run(env);
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							iox = el = evtOpts = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

function onceEvent(el,evtName,evtOpts = false) {
	var listener;
	var subscribed = false;
	var fired = false;
	var iox = onEvent(el,evtName,evtOpts);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// ***************************

	function subscribe() {
		/* istanbul ignore else */
		if (!subscribed && !listener && iox) {
			subscribed = true;

			// listen for when the event fires
			listener = IOx(onFire,[ iox, ]);
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscribed && listener) {
			subscribed = false;

			listener.close();
			listener = null;
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (iox) {
			/* istanbul ignore else */
			if (_run) {
				iox.run = _run;
			}
			subscribe();
			/* istanbul ignore else */
			if (listener) {
				return listener.run(env);
			}
		}
	}

	function stop() {
		/* istanbul ignore else */
		if (iox) {
			iox.run = run;
			unsubscribe();
			_stop();
		}
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							iox = listener = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

	function onFire() {
		/* istanbul ignore else */
		if (!fired) {
			fired = true;
			close();
		}
	}

}

function onTimer(updateInterval,countLimit) {
	var subscribed = false;
	var intv;
	var timer = IOx(effect,[]);
	countLimit = (
		typeof countLimit == "number" ?
			Math.max(1,countLimit || 1) :
			undefined
	);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = timer;

	// overwrite methods with wrapped versions
	Object.assign(timer,{ run, stop, close, });

	return timer;

	// *****************************************

	function effect() {
		subscribe();
		return EMPTY;
	}

	function subscribe() {
		/* istanbul ignore else */
		if (!subscribed && !intv) {
			subscribed = true;
			intv = setInterval(onTick,updateInterval);
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscribed && intv) {
			subscribed = false;
			clearInterval(intv);
			intv = null;
		}
	}

	function run(env) {
		subscribe();
		/* istanbul ignore else */
		if (_run) {
			return _run(env);
		}
	}

	function onTick() {
		/* istanbul ignore else */
		if (timer) {
			timer("tick");
		}
		if (typeof countLimit == "number") {
			countLimit--;
			if (close && countLimit <= 0) {
				close();
			}
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (timer) {
			// restore original methods
			Object.assign(timer,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return timer.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							timer = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

function zip(ioxs = []) {
	/* istanbul ignore else */
	if (Array.isArray(ioxs)) {
		ioxs = [ ...ioxs ];
	}

	var subscribed = false;
	var queues = new Map();
	var iox = IOx(effect,[]);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// *****************************************

	function effect(env) {
		return continuation(
			() => subscribe(env),
			() => EMPTY
		);
	}

	function subscribe(env) {
		if (!subscribed && iox) {
			subscribed = true;

			/* istanbul ignore else */
			if (Array.isArray(ioxs) && ioxs.length > 0) {
				return subscribeToIOxs(ioxs,env);
			}
		}
	}

	function subscribeToIOxs([ nextIOx, ...remainingIOxs ],env) {
		return continuation(
			() => {
				// need a queue to hold stream's values?
				if (!queues.has(nextIOx)) {
					queues.set(nextIOx,[]);
				}

				// register a listener for the stream?
				/* istanbul ignore else */
				if (registerHooks.has(nextIOx)) {
					let [ regListener, ] = registerHooks.get(nextIOx);
					return regListener(onUpdate,env);
				}
			},

			(remainingIOxs.length > 0 ?
				() => subscribeToIOxs(remainingIOxs,env) :
				checkListeners
			)
		);
	}

	function onUpdate(stream,v) {
		/* istanbul ignore else */
		if (iox && !iox.isClosed()) {
			if (v !== CLOSED) {
				/* istanbul ignore else */
				if (queues.has(stream)) {
					queues.get(stream).push(v);
				}
			}
			return checkListeners();
		}
	}

	function checkListeners() {
		/* istanbul ignore else */
		if (
			iox &&
			!iox.isClosed() &&
			Array.isArray(ioxs)
		) {
			// keep checking until we've drained all the
			// queues of values
			while (true) {
				let allStreamsClosed = true;
				let collectedQueues;
				let collectedValues;
				for (let x of ioxs) {
					// stream still open?
					if (x && !x.isClosed()) {
						allStreamsClosed = false;
					}

					// collect next value in queue?
					let queue = queues.get(x);
					if (queue.length > 0) {
						collectedValues = collectedValues || [];
						collectedQueues = collectedQueues || [];
						collectedValues.push(queue[0]);
						collectedQueues.push(queue);
					}
					// could stream still produce values?
					else if (x && !x.isClosed()) {
						// since we have no value for this
						// stream currently, done for now
						return;
					}
				}

				// collected values to emit?
				if (
					Array.isArray(collectedValues) &&
					Array.isArray(collectedQueues) &&
					collectedValues.length > 0 &&
					collectedQueues.length > 0
				) {
					// remove all the collected values from their
					// respective queues
					for (let queue of collectedQueues) {
						queue.shift();
					}

					// emit the collected values
					iox(collectedValues);
				}
				// otherwise, done for now
				else {
					// but, also need to close the zip stream?
					/* istanbul ignore else */
					if (allStreamsClosed) {
						return close(runSignal());
					}

					// note: shouldn't get here, but safety net
					// to prevent any sort of infinite loop
					/* istanbul ignore next */
					return;
				}
			}
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscribed && iox) {
			subscribed = false;

			/* istanbul ignore else */
			if (Array.isArray(ioxs) && ioxs.length > 0) {
				for (let x of ioxs) {
					if (registerHooks.has(x)) {
						let [ , unregListener, ] = registerHooks.get(x);
						unregListener(onUpdate);
					}
				}
			}
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (_run) {
			let cont = continuation(
				() => subscribe(env),
				() => _run(env)
			);
			return (isRunSignal(env) ? cont : trampoline(cont));
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							queues = iox = ioxs = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

function merge(ioxs = []) {
	/* istanbul ignore else */
	if (Array.isArray(ioxs)) {
		ioxs = [ ...ioxs ];
	}

	var subscribed = false;
	var iox = IOx(effect,[]);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// *****************************************

	function effect(env) {
		return continuation(
			() => subscribe(env),
			() => EMPTY
		);
	}

	function subscribe(env) {
		if (!subscribed && iox) {
			subscribed = true;

			/* istanbul ignore else */
			if (Array.isArray(ioxs) && ioxs.length > 0) {
				return subscribeToIOxs(ioxs,env);
			}
		}
	}

	function subscribeToIOxs([ nextIOx, ...remainingIOxs ],env) {
		return continuation(
			() => {
				// register a listener for the stream?
				/* istanbul ignore else */
				if (registerHooks.has(nextIOx)) {
					let [ regListener, ] = registerHooks.get(nextIOx);
					return regListener(onUpdate,env);
				}
			},

			(remainingIOxs.length > 0 ?
				() => subscribeToIOxs(remainingIOxs,env) :
				checkListeners
			)
		);
	}

	function onUpdate(_,v) {
		/* istanbul ignore else */
		if (iox && !iox.isClosed()) {
			if (v !== CLOSED) {
				iox(v);
			}
			return checkListeners();
		}
	}

	function checkListeners() {
		/* istanbul ignore else */
		if (
			iox &&
			!iox.isClosed() &&
			// all merged streams closed?
			Array.isArray(ioxs) && ioxs.length > 0 &&
			ioxs.every(x => x ? x.isClosed() : true)
		) {
			return close(runSignal());
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscribed && iox) {
			subscribed = false;

			if (Array.isArray(ioxs)) {
				for (let x of ioxs) {
					if (registerHooks.has(x)) {
						let [ , unregListener, ] = registerHooks.get(x);
						unregListener(onUpdate);
					}
				}
			}
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (_run) {
			let cont = continuation(
				() => subscribe(env),
				() => _run(env)
			);
			return (isRunSignal(env) ? cont : trampoline(cont));
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							iox = ioxs = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

function fromIO(io) {
	return IOx(skipFirstIdentity,[ io, ]);
}

function skipFirstIdentity(env,v) { return v; }

function fromIter($V,closeOnComplete = true) {
	// note: the internals of `fromIter(..)` are
	// all async, so no need for the trampolining
	// here

	const PAUSED = Symbol("paused");
	var signalPaused;
	var hasPaused;
	var subscribed = false;
	var it;
	var outerThis = this;
	var iox = IOx(effect,[]);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// *****************************************

	function effect() {
		subscribe();
		return EMPTY;
	}

	async function drainIterator() {
		var stillListening = true;
		try {
			while (subscribed) {
				let res = it.next();
				if (isPromise(res)) {
					res = await Promise.race([ hasPaused, res, ]);
				}

				/* istanbul ignore else */
				if (res) {
					if (res === CLOSED || !subscribed || res.done) {
						break;
					}
					else if (isPromise(res.value)) {
						res = await Promise.race([ hasPaused, res.value, ]);
						if (res === CLOSED || !stillListening) {
							break;
						}
						iox(res);
					}
					else {
						iox(res.value);
					}
				}
				else {
					// note: should never get here
					/* istanbul ignore next */
					break;
				}
			}
		}
		finally {
			stillListening = false;
			if (closeOnComplete && close) {
				close();
			}
			else {
				await unsubscribe();
			}
		}
	}

	function getIter(v) {
		return (
			// (async) generator?
			isFunction(v) ? v.call(outerThis) :
			// (async) iterator?
			(v && isFunction(v.next)) ? v :
			// sync iterable?
			(v && v[Symbol.iterator]) ? v[Symbol.iterator]() :
			// async iterable?
			(v && v[Symbol.asyncIterator]) ? v[Symbol.asyncIterator]() :
			undefined
		);
	}

	function subscribe() {
		/* istanbul ignore else */
		if (!subscribed && iox) {
			subscribed = true;
			it = getIter($V);
			({ pr: hasPaused, next: signalPaused, } = getDeferred());
			drainIterator().catch(logUnhandledError);
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscribed && iox) {
			if (signalPaused) {
				signalPaused(CLOSED);
				hasPaused = signalPaused = null;
			}
			subscribed = false;
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (_run) {
			return _run(env);
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							iox = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

// note: the internals of `toIter(..)` are
// all async, so no need for the trampolining
// here
function toIter(iox,env) {
	var finalPr;
	var prQueue = [];
	var nextQueue = [];
	var closed = false;
	var subscribed = false;
	var it = {
		[Symbol.asyncIterator]() { return this; },
		next: doNext,
		return: doReturn,
	};

	return it;

	// *****************************************

	function emptyResult(v) {
		return { value: v, done: true, };
	}

	function primeQueues() {
		var { pr, next, } = getDeferred();
		prQueue.push(pr);
		nextQueue.push(next);
	}

	function subscribe() {
		// can we register a listener for the IOx?
		/* istanbul ignore else */
		if (!subscribed && registerHooks.has(iox)) {
			subscribed = true;

			let [ regListener, ] = registerHooks.get(iox);
			trampoline(regListener(onIOxUpdate,env));
		}
	}

	function unsubscribe() {
		// can we unregister our listener from the IOx?
		/* istanbul ignore else */
		if (registerHooks.has(iox)) {
			let [ , unregListener, ] = registerHooks.get(iox);
			unregListener(onIOxUpdate);
		}
	}

	function onIOxUpdate(_,v) {
		// IOx has closed and nothing is pending in the queue?
		if (v === CLOSED) {
			if (prQueue.length == 0) {
				doReturn();
			}
		}
		else {
			/* istanbul ignore else */
			if (!closed) {
				if (nextQueue.length == 0) {
					primeQueues();
				}
				let next = nextQueue.shift();
				next({ value: v, done: false, });
			}
		}
	}

	function doNext() {
		// iterator already closed?
		if (closed) {
			return Promise.resolve(emptyResult());
		}
		else if (
			// IOx is currently closed?
			iox.isClosed() &&

			// nothing currently pending?
			prQueue.length == 0
		) {
			return doReturn();
		}

		if (prQueue.length == 0) {
			primeQueues();
		}
		var pr = prQueue.shift();

		// need to initially subscribe?
		if (!subscribed) {
			subscribe();
		}

		return pr;
	}

	function doReturn(v) {
		var res = emptyResult(v);

		if (!closed) {
			closed = true;

			unsubscribe();

			// make sure return() result is the last to resolve
			finalPr = (
				prQueue.length > 0 ?
					prQueue[prQueue.length - 1] :
					undefined
			);

			// clear out any pending results
			if (nextQueue.length > 0) {
				for (let next of nextQueue) {
					next(emptyResult());
				}
			}
			nextQueue = prQueue = env = iox = onIOxUpdate =
				primeQueues = doNext = doReturn = it = null;
		}

		return (
			finalPr ?

				// make sure return() result is the last to
				// resolve
				finalPr.then(()=>{
					try {
						return res;
					}
					finally {
						finalPr = res = null;
					}
				}) :

				Promise.resolve(res)
		);
	}

}

function fromObservable(obsv) {
	var subscription = null;
	var iox = IOx(effect,[]);

	// save original methods
	var { run: _run, stop: _stop, close: _close, } = iox;

	// overwrite methods with wrapped versions
	Object.assign(iox,{ run, stop, close, });

	return iox;

	// *****************************************

	function effect() {
		subscribe();
		return EMPTY;
	}

	function subscribe() {
		/* istanbul ignore else */
		if (!subscription && iox) {
			// (lazily) setup observable subscription
			subscription = obsv.subscribe({
				next: v => iox(v),
				error: logUnhandledError,
				complete: close,
			});
		}
	}

	function unsubscribe() {
		/* istanbul ignore else */
		if (subscription) {
			// discard observable subscription
			subscription.unsubscribe();
			subscription = null;
		}
	}

	function run(env) {
		/* istanbul ignore else */
		if (_run) {
			subscribe();
			return _run ? _run(env) : undefined;
		}
	}

	function stop() {
		unsubscribe();
		_stop();
	}

	function close(signal) {
		/* istanbul ignore else */
		if (iox) {
			// restore original methods
			Object.assign(iox,{
				run: _run, stop: _stop, close: _close,
			});
			stop();

			let cont = continuation(
				() => {
					try {
						return iox.close(signal);
					}
					finally {
						run = _run = _stop = stop = _close = close =
							iox = obsv = subscription = null;
					}
				}
			);
			return (isRunSignal(signal) ? cont : trampoline(cont));
		}
	}

}

/* istanbul ignore next */
function logUnhandledError(err) {
	if (Either.Left.is(err)) {
		console.log(
			err.fold(identity,EMPTY_FUNC)
		);
	}
	else if (isMonad(err)) {
		console.log(err._inspect());
	}
	else if (isFunction(err.toString)) {
		console.log(err.toString());
	}
	else {
		console.log(err);
	}
}

function defineNeverIOx() {
	const TAG = "NeverIOx";
	const origBind = NeverIOx$.bind;
	var publicAPI = Object.assign(NeverIOx$,{
		map: NeverIOx$, chain: NeverIOx$, flatMap: NeverIOx$,
		bind: NeverIOx$, concat: NeverIOx$, run: EMPTY_FUNC,
		stop: EMPTY_FUNC, close: EMPTY_FUNC, isClosed,
		never: NeverIOx$, isNever, toString,
		_chain_with_IO, _inspect, _bind: origBind,
		_is: IOx.is, [Symbol.toStringTag]: TAG,
	});
	registerHooks.set(publicAPI,[ EMPTY_FUNC, EMPTY_FUNC ]);
	return publicAPI;

	// *****************************************

	function NeverIOx$() { return publicAPI; }
	function isClosed() { return false; }
	function isNever() { return true; }
	function toString() { return `[function ${this[Symbol.toStringTag] || this.name}]`; }
	function _chain_with_IO() { return EMPTY_IO; }
	function _inspect() { return `${TAG}()`; }
}
