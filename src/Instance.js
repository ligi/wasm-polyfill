//
// The `Instance` object.
//
// This object takes a compiled module and provides the
// necessary run-time data to make live function objects.
// It's where we coordinate the details of passing values
// back-and-forth between JS and WASM.
//

import WebAssembly from "./index"

import Module from "./Module"
import Table from "./Table"
import Memory from "./Memory"
import stdlib from "./stdlib"
import { SECTIONS, EXTERNAL_KINDS } from "./constants"
import { LinkError, RuntimeError } from "./errors"
import {
  assertIsDefined,
  assertIsInstance,
  assertIsCallable,
  ToJSValue,
  ToWASMValue,
  makeSigStr
} from "./utils"

  
export default function Instance(moduleObject, importObject) {
  assertIsDefined(this)
  assertIsInstance(moduleObject, Module)
  if (typeof importObject !== "undefined") {
    if (typeof importObject !== "object") {
      throw new TypeError()
    }
  }

  // Collect, type-check and coerce the imports.

  var sections = moduleObject._internals.sections
  var imports = [];
  (sections[SECTIONS.IMPORT] || []).forEach(function(i) {
    var o = importObject[i.module_name]
    assertIsInstance(o, Object)
    var v = o[i.item_name]
    if (typeof v === "undefined") {
      throw new TypeError("cannot import undefined")
    }
    switch(i.kind) {
      case EXTERNAL_KINDS.FUNCTION:
        assertIsCallable(v)
        if (! v._wasmRawFunc) {
          // If this is not a function from another WASM instance, then we
          // have to convert args and return values between WASM and JS semantics.
          // XXX TODO: we could probably make a more efficient translation layer...
          var typ = sections[SECTIONS.TYPE][i.type]
          imports.push(function() {
            var args = []
            var origArgs = arguments
            typ.param_types.forEach(function(param_typ, idx) {
              args.push(ToJSValue(origArgs[idx], param_typ))
            })
            var res = v.apply(undefined, args)
            if (typ.return_types.length > 0) {
              res = ToWASMValue(res, typ.return_types[0])
            }
            return res
          })
        } else {
          // If importing functions from another WASM instance,
          // we can shortcut *and* we can do more typechecking.
          if (v._wasmRawFunc._wasmTypeSigStr !== makeSigStr(sections[SECTIONS.TYPE][i.type])) {
            throw new TypeError("function import type mis-match")
          }
          imports.push(v._wasmRawFunc)
        }
        break
      case EXTERNAL_KINDS.GLOBAL:
        imports.push(ToWASMValue(v, i.type.content_type))
        break
      case EXTERNAL_KINDS.MEMORY:
        assertIsInstance(v, Memory)
        if (v._internals.current < i.type.limits.initial) {
          throw new TypeError("memory import too small")
        }
        if (i.type.limits.maximum) {
          if (v._internals.current > i.type.limits.maximum) {
            throw new TypeError("memory import too big")
          }
          if (!v._internals.maximum || v._internals.maximum > i.type.limits.maximum) {
            throw new TypeError("memory import has too large a maximum")
          }
        }
        imports.push(v)
        break
      case EXTERNAL_KINDS.TABLE:
        assertIsInstance(v, Table)
        if (v.length < i.type.limits.initial) {
          throw new TypeError("table import too small")
        }
        if (i.type.limits.maximum) {
          if (v.length > i.type.limits.maximum) {
            throw new TypeError("table import too big")
          }
          if (!v._internals.maximum || v._internals.maximum > i.type.limits.maximum) {
            throw new TypeError("table import has too large a maximum")
          }
        }
        imports.push(v)
        break
      default:
        throw new RuntimeError("unexpected import kind: " + i.kind)
    }
  })

  // Instantiate the compiled javascript module, which will give us all the exports.
  var constants = moduleObject._internals.constants
  this._exports = moduleObject._internals.jsmodule(WebAssembly, imports, constants, stdlib)
  this.exports = {}
  var self = this;
  (moduleObject._internals.sections[SECTIONS.EXPORT] || []).forEach(function(e) {
    switch (e.kind) {
      case EXTERNAL_KINDS.FUNCTION:
        var wasmFunc = self._exports[e.field]
        // Wrap exported functions to convert between JS and WASM value semantics.
        // We cache the wrapper on the function.
        if (!wasmFunc._wasmJSWrapper) {
          wasmFunc._wasmJSWrapper = function () {
            // Type-check and coerce arguments.
            // XXX TODO: we could probably use raw type info rather than sigstr here.
            // XXX TODO: can we come up with a more efficient system for this, one
            // that doesn't use the `arguments` object in common cases?
            var args = []
            ARGLOOP: for (var i = 0; i < wasmFunc._wasmTypeSigStr.length; i++) {
              switch (wasmFunc._wasmTypeSigStr.charAt(i)) {
                case 'i':
                  args.push(arguments[i]|0)
                  break
                case 'l':
                  throw new RuntimeError("cannot pass i64 from js: " + arguments[i])
                case 'f':
                  args.push(Math.fround(+arguments[i]))
                  break
                case 'd':
                  args.push(+arguments[i])
                  break
                case '-':
                  break ARGLOOP
                default:
                  throw new RuntimeError("malformed _wasmTypeSigStr")
              }
            }
            try {
              return wasmFunc.apply(this, args)
            } catch (err) {
              // For test compatibilty, we want stack space exhaustion to trap.
              // XXX TODO: this can't really be necessary in practice, right?
              // Surely just passing through the RangeError would suffice?
              if (err instanceof RangeError) {
                if (err.message.indexOf("call stack") >= 0) {
                  throw new RuntimeError("call stack exhausted")
                }
              }
              throw err
            }
          }
          wasmFunc._wasmJSWrapper._wasmRawFunc = wasmFunc
        }
        self.exports[e.field] = wasmFunc._wasmJSWrapper
        break
      default:
        self.exports[e.field] = self._exports[e.field]
    }
  })
}
