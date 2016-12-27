(function(globalScope) {

  //
  // The exports, trying to match the builtin JS API as much as possible.
  // 

  var WebAssembly =  {
    CompileError: CompileError,
    Instance: Instance,
    Memory: Memory,
    Module: Module,
    RuntimeError: RuntimeError,
    Table: Table,
    compile: compile,
    instantiate: instantiate,
    validate: validate
  }

  if (typeof module !== "undefined") {
    if (typeof module.exports !== "undefined") {
      module.exports = WebAssembly;
    }
  }

  if (globalScope && typeof globalScope.WebAssembly === "undefined")  {
    globalScope.WebAssembly = WebAssembly
  }

  //
  // Custom error subclasses.
  // Nothing too unusual here.
  //

  function CompileError(message) {
    this.message = message || ""
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, CompileError);
    }
  }
  CompileError.prototype = new Error()
  CompileError.prototype.constructor = CompileError

  function RuntimeError(message) {
    this.message = message || ""
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, RuntimeError);
    }
  }
  RuntimeError.prototype = new Error()
  RuntimeError.prototype.constructor = RuntimeError


  //
  // The top-level aync helper functions.
  // For the moment they're only pretend-async but eventually
  // we might try to move some of the parsing work to a worker.
  //

  function validate(bytes) {
    try {
      new Module(bytes)
    } catch (err) {
      if (err instanceof CompileError) {
        return false
      }
      throw err
    }
    return true
  }

  function compile(bytes) {
    // XXX TODO: semantically, we should operate on a copy of bytes.
    return new Promise(function(resolve) {
      resolve(new Module(bytes))
    })
  }

  function instantiate(bytesOrModuleObjec , importObject) {
    var buf = arrayBufferFromBufferSource(bytesOrModuleObject)
    if (buf !== null) {
      return compile(buf).then(function(m) {
        return instantiate(m, importObject).then(function(i) {
          return {module: m, instance: i}
        })
      })
    }
    return new Promise(function(resolve) {
      resolve(new Instance(bytesOrModuleObject, importObject))
    })
  }

  //
  // The `Module` object.
  //
  // We try to match as closely as possible the defined semantics
  // of a native implementation, but of course it's kinda hard to
  // catch all the edge-cases.
  //

  function Module(bufferSource) {
    assertIsDefined(this)
    var bytes = new Uint8Array(arrayBufferFromBufferSource(bufferSource))
    var sections = parseBinaryEncoding(bytes)
    this._internals = {
      sections: sections,
      jsmodule: renderSectionsToJS(sections)
    }
  }

  Module.exports = function exports(moduleObject) {
    assertIsInstance(moduleObject, Module)
    var exports = moduleObject._internals.sections[SECTIONS.EXPORT] || []
    return exports.map(function(e) {
      return {
        name: e.field, // XXX TODO: convert from utf8
        kind: EXTERNAL_KIND_NAMES[e.kind]
      }
    })
  }

  Module.imports = function imports(moduleObject) {
    assertIsInstance(moduleObject, Module)
    var imports = moduleObject._internals.sections[SECTIONS.IMPORT] || []
    return imports.map(function(i) {
      return {
        name: i.field, // XXX TODO: convert from utf8
        kind: EXTERNAL_KIND_NAMES[i.kind]
      }
    })
  }

  // XXX TODO: Module needs to be cloneable.
  // How to make this so?

  //
  // The `Instance` object.
  //

  function Instance(moduleObject, importObject) {
    assertIsDefined(this)
    assertIsInstance(moduleObject, Module)
    if (typeof importObject !== "undefined") {
      if (typeof importObject !== "object") {
        throw new TypeError()
      }
    }
    // Collect, type-check and coerce the imports.
    var importDefs = moduleObject._internals.sections[SECTIONS.IMPORT] || []
    var imports = []
    importDefs.forEach(function(i) {
      var o = importObject[i.module_name]
      assertIsInstance(o, Object)
      var v = o[i.item_name]
      switch(i.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          assertIsCallable(v)
          // XXX TODO: check signature on Exported Function Exotic Object?
          // XXX TODO: create host function that does necessary type mapping
          // of args and return value.
          imports.push(v)
          break
        case EXTERNAL_KINDS.GLOBAL:
          // XXX TODO: check if i is an immutable global, TypeError if not
          assertIsType(v, "number")
          imports.push(ToWebAssemblyValue(v))
          break
        case EXTERNAL_KINDS.MEMORY:
          assertInstanceOf(v, Memory)
          imports.push(v)
          break
        case EXTERNAL_KINDS.TABLE:
          assertInstanceOf(v, Table)
          imports.push(v)
          break
        default:
          throw new RuntimeError("unexpected import kind: " + i.kind)
      }
    })
    // Instantiate the compiled javascript module,
    // which will give us all the exports.
    this.exports = moduleObject._internals.jsmodule(imports)
    // XXX TODO: Evaluate the `offset` initializer expression
    // of every Data and Element Segment, thow RangeError if any
    // do not fit in their respective Memory or Table.
    // --
    // XXX TODO: Apply Data segments to their respective memory.
    // --
    // XXX TODO: Apply Element segments to their respective table.
    // --
    // XXX TODO: if `start` is present, evaluate it
  }


  //
  // The `Memory` object.
  //
  // We do the best with can to immitate the growable memory
  // object from WASM on top of normal ArrayBuffers.
  //

  var PAGE_SIZE = 64 * 1024

  function Memory(memoryDescriptor) {
    assertIsDefined(this)
    assertIsType(memoryDescriptor, "object")
    var initial = ToNonWrappingUint32(memoryDescriptor.initial)
    var maximum = null
    if (memoryDescriptor.hasOwnProperty("maximum")) {
      maximum = ToNonWrappingUint32(memoryDescriptor.maximum)
    }
    this._internals = {
      buffer: new ArrayBuffer(initial * PAGE_SIZE),
      initial: initial,
      current: initial,
      maximum: maximum
    }
  }

  Memory.prototype.grow = function grow(delta) {
    assertIsInstance(this, Memory)
    // XXX TODO: guard against overflow?
    var oldSize = this._internals.current
    var newSize = oldSize + ToNonWrappingUint32(delta)
    if (this._internals.maximum !== null) {
      if (newSize > this._internals.maximum) {
        throw new RangeError()
      }
    }
    var newBuffer = new ArrayBuffer(newSize * PAGE_SIZE)
    // XXX TODO efficient copy of the old buffer
    notImplemented("copy from old buffer to new buffer")
    // XXX TODO: cleanly detach the old buffer
    this._internals.buffer = newBuffer
    this._internals.current = newSize
    return oldSize
  }

  Object.defineProperty(Memory.prototype, "buffer", {
    // XXX TODO: do I need to do anything to prevent ths buffer
    // from being detached by code that gets it?
    get: function() {
      assertIsInstance(this, Memory)
      return this._internals.buffer
    }
  })

  //
  // The `Table` object.
  //
  // For once this appears to be pretty straightforward...
  //

  function Table(tableDescriptor) {
    assertIsDefined(this)
    assertIsType(tableDescriptor, "object")
    var element = tableDescriptor.element
    if (element !== "anyfunc") {
      throw new TypeError()
    }
    var initial = ToNonWrappingUint32(tableDescriptor.initial)
    var maximum = null
    if (tableDescriptor.hasOwnProperty("maximum")) {
      maximum = ToNonWrappingUint32(tableDescriptor.maximum)
    }
    var values = new Array(initial)
    for (var i = 0; i < initial; i++) {
      values[i] = null
    }
    this._internals = {
      values: values,
      initial: initial,
      maximum: maximum
    }
  }

  Object.defineProperty(Table.prototype, "length", {
    get: function() {
      assertIsInstance(this, Table)
      return this._internals.values.length
    }
  })

  Table.prototype.grow = function grow(delta) {
    assertIsInstance(this, Table)
    // XXX TODO: guard against overflow?
    // XXX TODO: is it a delta in this context, like for Memory?
    var oldSize = this.length
    var newSize = oldSize + ToNonWrappingUint32(delta)
    if (this._internals.maximum !== null) {
      if (newSize > this._internals.maximum) {
        throw new RangeError()
      }
    }
    for (var i = oldSize; i < newSize; i++) {
      this._internals.values.push(null);
    }
    return oldSize
  }

  Table.prototype.get = function get(index) {
    assertIsInstance(this, Table)
    index = ToNonWrappingUint32(index)
    if (index >= this._internls.values.length) {
      throw RangeError
    }
    return this._internals.values[index]
  }

  Table.prototype.set = function set(index, value) {
    assertIsInstance(this, Table)
    index = ToNonWrappingUint32(index)
    // XXX TODO: value must be an Exported Function Exotic Object, TypeError otherwise
    if (index >= this._internls.values.length) {
      throw RangeError
    }
    // XXX TODO: we're supposed to extract the closure somehow?
    // Pretty sure that won't be necessary for a polyfill.
    this._internals.values[index] = value
  }


  //
  // Logic for parsing and validating WASM binary format.
  //
  // This is where the magic happens :-)
  // It's all pretty exploratory and ad-hoc for the moment,
  // while I figure out how I want to represent the results.
  //

  var TYPES = {
    I32: -0x01,
    I64: -0x02,
    F32: -0x03,
    F64: -0x04,
    ANYFUNC: -0x10,
    FUNC: -0x20,
    NONE: -0x40
  }

  var EXTERNAL_KINDS = {
    FUNCTION: 0,
    TABLE: 1,
    MEMORY: 2,
    GLOBAL: 3
  }

  var EXTERNAL_KIND_NAMES = {
    FUNCTION: "function",
    TABLE: "table",
    MEMORY: "memory",
    GLOBAL: "global"
  }

  var SECTIONS = {
    TYPE: 1,
    IMPORT: 2,
    FUNCTION: 3,
    TABLE: 4,
    MEMORY: 5,
    GLOBAL: 6,
    EXPORT: 7,
    START: 8,
    ELEMENT: 9,
    CODE: 10,
    DATA: 11
  }

  function parseBinaryEncoding(bytes) {

    // All the lovely constants we need to know about.

    var TOKENS = {
      MAGIC_NUMBER: 0x6d736100,
      VERSION_NUMBER: 0xd
    }

    var OPCODES = {
      // Control flow
      UNREACHABLE: 0x00,
      NOP: 0x01,
      BLOCK: 0x02,
      LOOP: 0x03,
      IF: 0x04,
      ELSE: 0x05,
      END: 0x0b,
      BR: 0x0c,
      BR_IF: 0x0d,
      BR_TABLE: 0x0e,
      RETURN: 0x0f,
      // Calls
      CALL: 0x10,
      CALL_INDIRECT: 0x11,
      // Parametric operators
      DROP: 0x1a,
      SELECT: 0x1b,
      // Variable accesses
      GET_LOCAL: 0x20,
      SET_LOCAL: 0x21,
      TEE_LOCAL: 0x22,
      GET_GLOBAL: 0x23,
      SET_GLOBAL: 0x24,
      // Memory-related operators
      I32_LOAD: 0x28,
      I64_LOAD: 0x29,
      F32_LOAD: 0x2a,
      F64_LOAD: 0x2b,
      I32_LOAD8_S: 0x2c,
      I32_LOAD8_U: 0x2d,
      I32_LOAD16_S: 0x2e,
      I32_LOAD16_U: 0x2f,
      I64_LOAD8_S: 0x30,
      I64_LOAD8_U: 0x31,
      I64_LOAD16_S: 0x32,
      I64_LOAD16_U: 0x33,
      I64_LOAD32_S: 0x34,
      I64_LOAD32_U: 0x35,
      I32_STORE: 0x36,
      I64_STORE: 0x37,
      F32_STORE: 0x38,
      F64_STORE: 0x39,
      I32_STORE8: 0x3a,
      I32_STORE16: 0x3b,
      I64_STORE8: 0x3c,
      I64_STORE16: 0x3d,
      I64_STORE32: 0x3e,
      CURRENT_MEMORY: 0x3f,
      GROW_MEMORY: 0x40,
      // Constants
      I32_CONST: 0x41,
      I64_CONST: 0x42,
      F32_CONST: 0x43,
      F64_CONST: 0x44,
      // Comparison operators
      I32_EQZ: 0x45,
      I32_EQ: 0x46,
      I32_NE: 0x47,
      I32_LT_S: 0x48,
      I32_LT_U: 0x49,
      I32_GT_S: 0x4a,
      I32_GT_U: 0x4b,
      I32_LE_S: 0x4c,
      I32_LE_U: 0x4d,
      I32_GE_S: 0x4e,
      I32_GE_U: 0x4f,
      I64_EQZ: 0x50,
      I64_EQ: 0x51,
      I64_NE: 0x52,
      I64_LT_S: 0x53,
      I64_LT_U: 0x54,
      I64_GT_S: 0x55,
      I64_GT_U: 0x56,
      I64_LE_S: 0x57,
      I64_LE_U: 0x58,
      I64_GE_S: 0x59,
      I64_GE_U: 0x5a,
      F32_EQ: 0x5b,
      F32_NE: 0x5c,
      F32_LT: 0x5d,
      F32_GT: 0x5e,
      F32_LE: 0x5f,
      F32_GE: 0x60,
      F64_EQ: 0x61,
      F64_NE: 0x62,
      F64_LT: 0x63,
      F64_GT: 0x64,
      F64_LE: 0x65,
      F64_GE: 0x66,
      // Numeric operators
      I32_CLZ: 0x67,
      I32_CTZ: 0x68,
      I32_POPCNT: 0x69,
      I32_ADD: 0x6a,
      I32_SUB: 0x6b,
      I32_MUL: 0x6c,
      I32_DIV_S: 0x6d,
      I32_DIV_U: 0x6e,
      I32_REM_S: 0x6f,
      I32_REM_U: 0x70,
      I32_AND: 0x71,
      I32_OR: 0x72,
      I32_XOR: 0x73,
      I32_SHL: 0x74,
      I32_SHR_S: 0x75,
      I32_SHR_U: 0x76,
      I32_ROTL: 0x77,
      I32_ROTR: 0x78,
      I64_CLZ: 0x79,
      I64_CTZ: 0x7a,
      I64_POPCNT: 0x7b,
      I64_ADD: 0x7c,
      I64_SUB: 0x7d,
      I64_NUL: 0x7e,
      I64_DIV_S: 0x7f,
      I64_DIV_U: 0x80,
      I64_REM_S: 0x81,
      I64_REM_U: 0x82,
      I64_AND: 0x83,
      I64_OR: 0x84,
      I64_XOR: 0x85,
      I64_SHL: 0x86,
      I64_SHR_S: 0x87,
      I64_SHR_U: 0x88,
      I64_ROTL: 0x89,
      I64_ROTR: 0x8a,
      F32_ABS: 0x8b,
      F32_NEG: 0x8c,
      F32_CEIL: 0x8d,
      F32_FLOOR: 0x8e,
      F32_TRUNC: 0x8f,
      F32_NEAREST: 0x90,
      F32_SQRT: 0x91,
      F32_ADD: 0x92,
      F32_SUB: 0x92,
      F32_MUL: 0x94,
      F32_DIV: 0x95,
      F32_MIN: 0x96,
      F32_MAX: 0x97,
      F32_COPYSIGN: 0x98,
      F64_ABS: 0x99,
      F64_NEG: 0x9a,
      F64_CEIL: 0x9b,
      F64_FLOOR: 0x9c,
      F64_TRUNC: 0x9d,
      F64_NEAREST: 0x9e,
      F64_SQRT: 0x9f,
      F64_ADD: 0xa0,
      F64_SUB: 0xa1,
      F64_MUL: 0xa2,
      F64_DIV: 0xa3,
      F64_MIN: 0xa4,
      F64_MAX: 0xa5,
      F64_COPYSIGN: 0xa6,
      // Conversions
      I32_WRAP_I64: 0xa7,
      I32_TRUNC_S_F32: 0xa8,
      I32_TRUNC_U_F32: 0xa9,
      I32_TRUN_S_F64: 0xaa,
      I32_TRUNC_U_F64: 0xab,
      I64_EXTEND_S_I32: 0xac,
      I64_EXTEND_U_I32: 0xad,
      I64_TRUNC_S_F32: 0xae,
      I64_TRUNC_U_F32: 0xaf,
      I64_TRUNC_S_F64: 0xb0,
      I64_TRUNC_U_F64: 0xb1,
      F32_CONVERT_S_I32: 0xb2,
      F32_CONCERT_U_I32: 0xb3,
      F32_CONVERT_S_I64: 0xb4,
      F32_CONVERT_U_I64: 0xb5,
      F32_DEMOTE_F64: 0xb6,
      F64_CONVERT_S_I32: 0xb7,
      F64_CONVERT_U_I32: 0xb8,
      F64_CONVERT_S_I64: 0xb9,
      F64_CONVERT_U_I64: 0xba,
      F64_PROMOTE_F32: 0xbb,
      // Reinterpretations
      I32_REINTERPRET_F32: 0xbc,
      I64_REINTERPRET_F64: 0xbd,
      F32_REINTERPRET_I32: 0xb3,
      F64_REINTERPRET_I64: 0xbf
    }

    // We parse in a single forward pass,
    // this is the current position in the input bytes.

    var idx = 0;

    // Here's what we actually do, but using a bunch
    // of helper functions defined below.

    var sections = [null]
    parseFileHeader()
    parseKnownSections()
    return sections

    // Basic helper functions for reading primitive values,
    // and doing some type-checking etc.  You can distinguish
    // primitive-value reads by being named read_XYZ()

    function read_byte() {
      return bytes[idx++]
    }

    function read_bytes(count) {
      output = []
      while (count > 0) {
        output.push(String.fromCharCode(bytes[idx++]))
        count--
      }
      return output.join("")
    }

    function read_uint8() {
      return bytes[idx++]
    }

    function read_uint16() {
      return (bytes[idx++]) |
             (bytes[idx++] << 8)
    }

    function read_uint32() {
      return (bytes[idx++]) |
             (bytes[idx++] << 8) |
             (bytes[idx++] << 16) |
             (bytes[idx++] << 24)
    }

    function read_varuint1() {
      var v = read_varuint32()
      // 1-bit int, no bits other than the very last should be set.
      if (v & 0xFFFFFFFE) {
        throw new CompileError("varuint1 too large")
      }
      return v
    }

    function read_varuint7() {
      var v = read_varuint32()
      // 7-bit int, none of the higher bits should be set.
      if (v & 0xFFFFFF80) {
        throw new CompileError("varuint7 too large")
      }
      return v
    }

    function read_varuint32() {
      var b = 0
      var result = 0
      var shift = 0
      do {
        if (shift > 32) {
          throw new CompileError("varuint32 too large")
        }
        b = bytes[idx++]
        result = ((b & 0x7F) << shift) | result
        shift += 7
      } while (b & 0x80)
      return result >>> 0
    }

    function read_varint7() {
      var v = read_varint32()
      if (v > 63 || v < -64) {
        throw new CompileError("varint7 too large")
      }
      return v
    }

    function read_varint32() {
      var b = 0
      var result = 0
      var shift = 0
      do {
        if (shift > 32) {
          throw new CompileError("varuint32 too large")
        }
        b = bytes[idx++]
        result = ((b & 0x7F) << shift) | result
        shift += 7
      } while (b & 0x80)
      if (b & 0x40) {
        result = (-1 << shift) | result
      }
      return result
    }

    function read_varint64() {
      // No 64-bit integers yet, because javascript.
      notImplemented()
    }

    function read_value_type() {
      var v = read_varint7()
      if (v >= 0 || v < TYPES.F64) {
        throw new CompileError("Invalid value_type: " + v)
      }
      return v
    }

    function read_block_type() {
      var v = read_varint7()
      if (v >= 0 || (v < TYPES.F64 && v !== TYPES.NONE)) {
        throw new CompileError("Invalid block_type: " + v)
      }
      return v
    }

    function read_elem_type() {
      var v = read_varint7()
      if (v !== TYPES.ANYFUNC) {
        throw new CompileError("Invalid elem_type: " + v)
      }
      return v
    }

    function read_external_kind() {
      var v = read_uint8()
      if (v > EXTERNAL_KINDS.GLOBAL) {
        throw new CompileError("Invalid external_kind: " + v)
      }
      return v
    }

    // Structural parsing functions.
    // These read several primitive values from the stream
    // and return an object with fields  You can distinguish
    // them because they're named parseXYZ().

    function parseFuncType() {
      var f = {}
      f.form = read_varint7()
      if (f.form !== TYPES.FUNC) {
        throw new CompileError("Invalid func_type form: " + f.form)
      }
      var param_count = read_varuint32()
      f.param_types = []
      while (param_count > 0) {
        f.param_types.push(read_value_type())
        param_count--
      }
      var return_count = read_varuint1()
      f.return_types = []
      while (return_count > 0) {
        f.return_types.push(read_value_type())
        return_count--
      }
      return f
    }

    function parseGlobalType() {
      var g = {}
      g.content_type = read_value_type()
      g.mutability = read_varuint1()
      return g
    }

    function parseTableType() {
      var t = {}
      t.element_type = read_elem_type()
      t.limits = parseResizableLimits()
      return t
    }

    function parseMemoryType() {
      var m = {}
      m.limits = parseResizableLimits()
      return m
    }

    function parseResizableLimits() {
      var l = {}
      var flags = read_varuint1()
      l.initial = read_varuint32()
      if (flags) {
        l.maximum = read_varuint32()
      } else {
        l.maximum = null
      }
      return l
    }

    function parseInitExpr() {
      notImplemented()
    }

    function parseFileHeader() {
      if (read_uint32() !== TOKENS.MAGIC_NUMBER) {
        throw new CompileError("incorrect magic number")
      }
      if (read_uint32() !== TOKENS.VERSION_NUMBER) {
        throw new CompileError("incorrect version number")
      }
    }

    function parseKnownSections() {
      while (idx < bytes.length) {
        var id = read_varuint7()
        // Ignoring named sections for now
        var payload_len = read_varuint32()
        var next_section_idx = idx + payload_len
        if (!id) {
          idx = next_section_idx
          continue
        }
        // Known sections are not allowed to appear out-of-order.
        if (id < sections.length) { throw new CompileError("out-of-order section") }
        // But some sections may be missing.
        while (sections.length < id) {
          sections.push(null)
        }
        sections.push(parseSection(id))
        // Check that we didn't ready past the declared end of section.
        // It's OK if there was some extra padding garbage in the payload data.
        if (idx > next_section_idx) {
          throw new CompileError("read past end of section")
        }
        idx = next_section_idx
      }
      if (idx !== bytes.length) {
        throw new CompileError("unepected end of bytes")
      }
    }

    function parseSection(id) {
      switch (id) {
        case SECTIONS.TYPE:
          return parseTypeSection()
        case SECTIONS.IMPORT:
          return parseImportSection()
        case SECTIONS.FUNCTION:
          return parseFunctionSection()
        case SECTIONS.TABLE:
          return parseTableSection()
        case SECTIONS.MEMORY:
          return parseMemorySection()
        case SECTIONS.GLOBAL:
          return parseGlobalSection()
        case SECTIONS.EXPORT:
          return parseExportSection()
        case SECTIONS.START:
          return parseStartSection()
        case SECTIONS.ELEMENT:
          return parseElementSection()
        case SECTIONS.CODE:
          return parseCodeSection()
        case SECTIONS.DATA:
          return parseDataSection()
        default:
          throw new CompileError("unknown section code: " + id)
      }
    }

    function parseTypeSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseFuncType())
        count--
      }
      return entries
    }

    function parseImportSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseImportEntry())
        count--
      }
      return entries

      function parseImportEntry() {
        var i = {}
        var module_len = read_varuint32()
        i.module_name = read_bytes(module_len)
        var field_len = read_varuint32()
        i.item_name = read_bytes(field_len)
        i.kind = read_external_kind()
        switch (i.kind) {
          case EXTERNAL_KINDS.FUNCTION:
            i.type = read_varuint32()
            break
          case EXTERNAL_KINDS.TABLE:
            i.type = parseTableType()
            break
          case EXTERNAL_KINDS.MEMORY:
            i.type = parseMemoryType()
            break
          case EXTERNAL_KINDS.GLOBAL:
            i.type = parseGlobalType()
            break
          default:
            throw new CompileError("unknown import kind:" + i.kind)
        }
        return i
      }
    }

    function parseFunctionSection() {
      var count = read_varuint32()
      var types = []
      while (count > 0) {
        types.push(read_varuint32())
        count--
      }
      return types
    }

    function parseTableSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseTableType())
        count--
      }
      if (entries.length > 1) {
        throw new CompileError("more than one table entry")
      }
      return entries
    }

    function parseMemorySection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseMemoryType())
        count--
      }
      if (entries.length > 1) {
        throw new CompileError("more than one memory entry")
      }
      return entries
    }

    function parseGlobalSection() {
      var count = read_varuint32()
      var globals = []
      while (count > 0) {
        globals.push(parseGlobalVariable())
        count--
      }
      return globals

      function parseGlobalVariable() {
        var g = {}
        g.type = parseGlobalType()
        g.init = parseInitExpr()
        return g
      }
    }

    function parseExportSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseExportEntry())
        count--
      }
      return entries

      function parseExportEntry() {
        var e = {}
        var field_len = read_varuint32()
        e.field = read_bytes(field_len)
        e.kind = read_external_kind()
        e.index = read_varuint32()
        // XXX TODO: early check that index is within bounds for relevant index space?
        return e
      }
    }

    function parseStartSection() {
      return read_varuint32()
    }

    function parseElementSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseElementSegment())
        count--
      }
      return entries

      function parseElementSegment() {
        var e = {}
        e.index = read_varuint32()
        if (e.index !== 0) {
          throw new CompileError("MVP requires elements index be zero")
        }
        e.offset = parseInitExpr()
        // XXX TODO: check tht initExpr is i32
        var num_elem = read_varuint32()
        e.elems = []
        while (num_elems > 0) {
          e.elems.push(read_varuint32())
          num_elems--
        }
        return e
      }
    }

    function parseCodeSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseFunctionBody(entries.length))
        count--
      }
      return entries
 
      function parseFunctionBody(index) {
        var f = {}
        // XXX TODO: check that the function entry exists
        f.name = "F" + index
        f.sig = sections[SECTIONS.TYPE][sections[SECTIONS.FUNCTION][index]]
        var body_size = read_varuint32()
        var end_of_body_idx = idx + body_size
        var local_count = read_varuint32()
        f.locals = []
        while (local_count > 0) {
          f.locals.push(parseLocalEntry())
          local_count--
        }
        f.code = parseFunctionCode(f)
        if (idx > end_of_body_idx) {
          throw new CompileError("read past function body")
        }
        idx = end_of_body_idx
        return f
      }

      function parseLocalEntry() {
        var e = {}
        e.count = read_varuint32()
        e.type = read_value_type()
        return e
      }

      // OK, this is where is gets interesting.
      // We attempt to convert the WASM opcode into a corresponding
      // javascript function.  It will be asmjs-like but we're not
      // going to worry about full validating asm compliance just yet,
      // not least because that doesn't support growable memory anyway.

      function parseFunctionCode(f) {
        var c = {
          numvars_local_i32: 0,
          numvars_local_f32: 0,
          numvars_local_f64: 0,
          numvars_stack_i32: 0,
          numvars_stack_f32: 0,
          numvars_stack_f64: 0,
          header_lines: ["function " + f.name + "(" + makeParamList() + ") {"],
          body_lines: [],
          footer_lines: ["}"]
        }

        function makeParamList() {
          var params = []
          f.sig.param_types.forEach(function(typ, idx) {
            params.push(getLocalVar(idx, typ))
          })
          return params.join(",")
        }

        var cfStack = [{
          op: 0,
          sig: 0, // XXX TODO: use function return sig?
          typeStack: [],
          prevStackHeights: {}
        }]
        cfStack[0].prevStackHeights[TYPES.I32] = 0
        cfStack[0].prevStackHeights[TYPES.F32] = 0
        cfStack[0].prevStackHeights[TYPES.F64] = 0

        function printStack() {
          console.log("--")
          for (var i = cfStack.length - 1; i >= 0; i--) {
            console.log(cfStack[i].typeStack)
          }
          console.log("--")
        }

        function pushControlFlow(op, sig) {
          var prevCf = cfStack[cfStack.length - 1]
          var prevStackHeights = {}
          prevStackHeights[TYPES.I32] = prevCf.prevStackHeights[TYPES.I32]
          prevStackHeights[TYPES.F32] = prevCf.prevStackHeights[TYPES.F32]
          prevStackHeights[TYPES.F64] = prevCf.prevStackHeights[TYPES.F64]
          prevCf.typeStack.forEach(function(typ) {
            prevStackHeights[typ] += 1
          })
          cfStack.push({
            op: op,
            sig: sig,
            index: cfStack.length,
            label: "L" + cfStack.length,
            typeStack: [],
            prevStackHeights: prevStackHeights
          })
        }

        function popControlFlow() {
          cf = cfStack.pop()
          return cf
        }

        function pushLine(ln, indent) {
          var indent = cfStack.length + (indent || 0) + 1
          while (indent > 0) {
            ln = "  " + ln
            indent--
          }
          c.body_lines.push(ln)
        }

        function pushStackVar(typ) {
          cfStack[cfStack.length - 1].typeStack.push(typ)
        }

        function peekStackType() {
          var stack = cfStack[cfStack.length - 1].typeStack
          if (stack.length === 0) {
            throw new CompileError("nothing on the stack")
          }
          return stack[stack.length - 1]
        }

        function popStackVar(wantType) {
          var name = getStackVar()
          var typ = cfStack[cfStack.length - 1].typeStack.pop()
          if (wantType && typ !== wantType) {
            throw new CompileError("Stack type mismatch")
          }
          return name
        }

        function getStackVar() {
          var cf = cfStack[cfStack.length - 1]
          var where = cf.typeStack.length - 1
          if (where < 0) {
            throw new CompileError("stack access outside current block")
          }
          var typ = cf.typeStack[where]
          var height = cf.prevStackHeights[typ]
          for (var i = 0; i < where; i++) {
            if (cf.typeStack[i] === typ) {
              height += 1
            }
          }
          switch (typ) {
            case TYPES.I32:
              return "si" + height
            case TYPES.F32:
              return "sf" + height
            case TYPES.F64:
              return "sd" + height
            default:
              throw new CompileError("unexpected type on stack")
          }
        }

        function getBlockOutputVar(cf) {
          if (cf.sig === TYPES.NONE) {
            throw new CompileError("No output from void block")
          }
          var height = cf.prevStackHeights[cf.sig] + 1
          switch (typ) {
            case TYPES.I32:
              return "si" + height
            case TYPES.F32:
              return "sf" + height
            case TYPES.F64:
              return "sd" + height
            default:
              throw new CompileError("unexpected type on stack")
          }
        }

        function getBranchTarget(depth) {
          var which = cfStack.length - (1 + depth)
          if (which <= 0) {
            throw new CompileError("Branch depth too large")
          }
          return cfStack[which]
        }

        function getFunctionSignature(index) {
          var typeSection = sections[SECTIONS.TYPE] || []
          if (index >= typeSection.length) {
            throw new CompileError("Invalid type index: " + index)
          }
          return typeSection[index]
        }

        function getLocalType(index) {
          var count = f.sig.param_types.length
          if (index < count) {
            return f.sig.param_types[index]
          }
          var next = 0
          while (next < f.locals.length) {
            count += f.locals[next].count
            if (count > index) {
              return f.locals[next].type
            }
            next++
          }
          throw new CompileError("local index too large: " + index)
        }

        function getLocalVar(index, typ) {
          typ = typ || getLocalType(index)
          switch (typ) {
            case TYPES.I32:
              return "li" + index
            case TYPES.F32:
              return "lf" + index
            case TYPES.F64:
              return "ld" + index
            default:
              throw new CompileError("unexpected type of local")
          }
        }

        function i32_unaryOp(what) {
          var operand = getStackVar(TYPES.I32)
          pushLine(operand + " = " + what + "(" + operand + ")")
        }

        function i32_binaryOp(what) {
          var lhs = popStackVar(TYPES.I32)
          var rhs = getStackVar(TYPES.I32)
          pushLine(rhs + " = " + lhs + " " + what + " " + rhs)
        }

        function i32_binaryFunc(what) {
          var lhs = popStackVar(TYPES.I32)
          var rhs = getStackVar(TYPES.I32)
          pushLine(rhs + " = " + what + "(" + lhs + ", " + rhs + ")")
        }

        DECODE: while (true) {
          var op = read_byte()
          switch (op) {

            case OPCODES.UNREACHABLE:
              pushLine("trap()")
              break

            case OPCODES.NOP:
              break

            case OPCODES.BLOCK:
              var sig = read_block_type()
              var cf = pushControlFlow(op, sig)
              pushLine(cf.label + ": do {", -1)
              break

            case OPCODES.LOOP:
              var sig = read_block_type()
              var cf = pushControlFlow(op, sig)
              pushLine(cf.label + ": while (1) {", -1)
              break

            case OPCODES.IF:
              var sig = read_block_type()
              pushControlFlow(op, sig)
              pushLine("if (" + popStackVar(TYPES.I32) + ") { " + cfStack.label + ": do {", -1)
              break

            case OPCODES.ELSE:
              // XXX TODO: need to sanity-check that the `if` branch
              // left precisely one value, of correct type, on the stack.
              // The push/pop here resets stack state between the two branches.
              var cf = popControlFlow()
              if (cf.op !== OPCODES.IF) {
                throw new CompileError("ELSE outside of IF")
              }
              pushLine("} else {")
              pushControlFlow(cf.op, cf.sig)
              break

            case OPCODES.END:
              if (cfStack.length === 1) {
                // End of the entire function.
                // XXX TODO: check that we're returning something of correct type
                pushLine("return " + popStackVar())
                break DECODE
              } else {
                // End of a control block
                var cf = popControlFlow()
                switch (cf.op) {
                  case OPCODES.BLOCK:
                    pushLine("} while(0)")
                    break
                  case OPCODES.LOOP:
                    pushLine("}")
                    break
                  case OPCODES.IF:
                    pushLine("} while (0) }")
                    break
                  default:
                    throw new CompileError("Popped an unexpected control op")
                }
                if (cf.sig !== TYPES.NONE) {
                  // XXX TODO: sanity-check that we left a single value of the
                  // correct type on the stack
                  pushStackVar(cf.sig)
                }
              }
              break

            case OPCODES.BR:
              var depth = read_varuint32()
              var cf = getBranchTarget(depth)
              switch (cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
                  if (cf.sig !== TYPES.NONE) {
                    var resultVar = popStackVar(cf.sig)
                    var outputVar = getBlockOutputVar(cf)
                    if (outputVar !== resultVar) {
                      pushLine(outputVar + " = " + resultVar)
                    }
                  }
                  pushLine("break " + cf.label)
                  break
                case OPCODES.LOOP:
                  pushLine("continue " + cf.label)
                  break
                default:
                  throw new CompileError("Branch to unsupported opcode")
              }
              break

            case OPCODES.BR_IF:
              var depth = read_varuint32()
              var cf = getBranchTarget(depth)
              switch (cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
                  pushLine("if (" + popStackVar(TYPES.I32) + ") {")
                  if (cf.sig !== TYPES.NONE) {
                    var resultVar = popStackVar(cf.sig)
                    var outputVar = getBlockOutputVar(cf)
                    if (outputVar !== resultVar) {
                      pushLine("  " + outputVar + " = " + resultVar)
                    }
                  }
                  pushLine("  break " + cf.label)
                  pushLine("}")
                  break
                case OPCODES.LOOP:
                  pushLine("if (" + popStackVar(TYPES.I32) + ") continue " + cf.label)
                  break
                default:
                  throw new CompileError("Branch to unsupported opcode")
              }
              break

            case OPCODES.BR_TABLE:
              // Terribly inefficient implementation of br_table
              // using a big ol' switch statement.
              var count = read_varuint32()
              var targets = []
              while (count > 0) {
                targets.push(read_varuint32())
              }
              var default_target = read_varuint32()
              var default_cf = getBranchTarget(default_target)
              pushLine("switch(" + popStackVar(TYPES.I32) + ") {")
              // XXX TODO: typechecking that all targets accept the
              // same result type etc.
              var resultVar = null;
              if (default_cf.sig !== TYPES.NONE) {
                resultVar = popStackVar(default_cf.sig)
              }
              targets.forEach(function(target) {
                pushLine("  case " + target + ":")
                var cf = getBranchTarget(target)
                if (cf.sig !== TYPES.NONE) {
                  var outputVar = getBlockOutputVar(cf)
                  if (outputVar !== resultVar) {
                    pushLine("    " + outputVar + " = " + resultVar)
                  }
                }
                switch (cf.op) {
                  case OPCODES.BLOCK:
                  case OPCODES.IF:
                    pushLine("    break " + cf.label)
                    break
                  case OPCODES.LOOP:
                    pushLine("    continue " + cf.label)
                    break
                }
              })
              pushLine("  default:")
              if (default_cf.sig !== TYPES.NONE) {
                var outputVar = getBlockOutputVar(default_cf)
                if (outputVar !== resultVar) {
                  pushLine("    " + outputVar + " = " + resultVar)
                }
              }
              switch (default_cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
                  pushLine("    break " + default_cf.label)
                  break
                case OPCODES.LOOP:
                  pushLine("    continue " + default_cf.label)
                  break
              }
              pushLine("}")
              notImplemented()
              break

            case OPCODES.BR_RETURN:
              // XXX TODO: check that we're returning something of correct type
              pushLine("return " + popStackVar())
              break

            case OPCODES.CALL:
              var index = read_varuint32()
              var callSig = getFunctionSignature(index)
              // XXX TODO: in what order do we pop args, FIFO or LIFO?
              var args = []
              callSig.param_types.forEach(function(typ) {
                args.push(popStackVar(typ))
              })
              pushLine("F" + index + "(" + args.join(",") + ")")
              callSig.return_types.forEach(function(typ) {
                pushStackVar(type)
              })
              break

            case OPCODES.CALL_INDIRECT:
              var type_index = read_varuint32()
              if (read_varuint1() !== 0) {
                throw new CompileError("MVP reserved-value constraint violation")
              }
              var callSig = getFunctionSignature(type_index)
              // XXX TODO: in what order do we pop args, FIFO or LIFO?
              var args = []
              callSig.param_types.forEach(function(typ) {
                args.push(popStackVar(typ))
              })
              // XXX TODO: how to dynamically check call signature?
              // Shall we just always call a stub that does this for us?
              // Shall weuse asmjs-style signature-specific tables with
              // placeholders tht trap?
              pushLine("TABLE[" + popStackVar(TYPES.I32) + "](" + args.join(",") + ")")
              callSig.return_types.forEach(function(typ) {
                pushStackVar(type)
              })
              break

            case OPCODES.DROP:
              popStackVar()
              break

            case OPCODES.SELECT:
              var condVar = popStackVar(TYPES.I32)
              var typ = peekStackType()
              var falseVar = popStackVar(typ)
              var trueVar = popStackVar(typ)
              pushStackVar(typ)
              var outputVar = getStackVar()
              pushLine(outputVar + " = " + condVar + " ? " + trueVar + ":" + falseVar)
              break

            case OPCODES.GET_LOCAL:
              var index = read_varuint32()
              pushStackVar(getLocalType(index))
              pushLine(getStackVar() + " = " + getLocalVar(index))
              break

            case OPCODES.SET_LOCAL:
              var index = read_varuint32()
              pushLine(getLocalVar(index) + " = " + popStackVar(getLocalType(index)))
              break

            case OPCODES.TEE_LOCAL:
              var index = read_varuint32()
              var typ = getLocalType(index)
              pushLine(getLocalVar(index) + " = " + popStackVar(typ))
              pushStackVar(typ) // this var will already contain the previous value
              break

            case OPCODES.GET_GLOBAL:
              var index = read_varuint32()
              var typ = getGlobalType(index)
              pushStackVar(typ)
              pushLine(getStackVar() + " = " + getGlobalVar(index, typ))
              break

            case OPCODES.SET_GLOBAL:
              var index = read_varuint32()
              var typ = getGlobalType(index)
              pushLine(getGlobalVar(index, typ) + " = " + popStackVar(typ))
              break

            case OPCODES.I32_EQZ:
              var operand = getStackVar(TYPES.I32)
              pushLine(operand + " = (" + operand + " === 0)|0")
              break

            case OPCODES.I32_EQ:
              i32_binaryOp("===")
              break

            case OPCODES.I32_NE:
              i32_binaryOp("!==")
              break

            case OPCODES.I32_LT_S:
              i32_binaryOp("<")
              break

            case OPCODES.I32_LT_U:
              i32_binaryOp("<") // XXX TODO: incorrect
              break

            case OPCODES.I32_GT_S:
              i32_binaryOp(">")
              break

            case OPCODES.I32_GT_U:
              i32_binaryOp(">") // XXX TODO: incorrect
              break

            case OPCODES.I32_LE_S:
              i32_binaryOp("<=")
              break

            case OPCODES.I32_LE_U:
              i32_binaryOp("<=") // XXX TODO: incorrect
              break

            case OPCODES.I32_GE_S:
              i32_binaryOp(">=")
              break

            case OPCODES.I32_GE_U:
              i32_binaryOp(">=") // XXX TODO: incorrect
              break

            case OPCODES.I32_CLZ:
              i32_unaryOp("clz")
              break

            case OPCODES.I32_CTZ:
              var op = getStackVar(TYPES.I32)
              pushLine(op + " = ctz(" + op + ")")
              break

            case OPCODES.I32_POPCNT:
              var op = getStackVar(TYPES.I32)
              pushLine(op + " = popcnt(" + op + ")")
              break

            case OPCODES.I32_ADD:
              i32_binaryOp("+")
              break

            case OPCODES.I32_SUB:
              i32_binaryOp("-")
              break

            case OPCODES.I32_MUL:
              i32_binaryFunc("imul")
              break

            case OPCODES.I32_DIV_S:
              i32_binaryOp("/")
              break

            case OPCODES.I32_DIV_U:
              i32_binaryOp("/")
              break

            case OPCODES.I32_REM_S:
              i32_binaryOp("%")
              break

            case OPCODES.I32_REM_U:
              i32_binaryOp("%")
              break

            case OPCODES.I32_AND:
              i32_binaryOp("&")
              break

            case OPCODES.I32_OR:
              i32_binaryOp("|")
              break

            case OPCODES.I32_XOR:
              i32_binaryOp("^")
              break

            case OPCODES.I32_SHL:
              i32_binaryOp("<<")
              break

            case OPCODES.I32_SHR_S:
              i32_binaryOp(">>")
              break

            case OPCODES.I32_SHR_U:
              i32_binaryOp(">>>")
              break

            case OPCODES.I32_ROTL:
              i32_binaryFunc("rotl")
              break

            case OPCODES.I32_ROTR:
              i32_binaryFunc("rotr")
              break

            default:
              throw new CompileError("unsupported opcode: " + op)
          }
        }

        return c
      }
    }

    function parseDataSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseDataSegment())
        count--
      }
      return entries
    }

    function parseDataSegment() {
      var d = {}
      d.index = read_varuint32()
      if (d.index !== 0) {
        throw new CompileError("MVP requires data index be zero")
      }
      d.offset = parseInitExprt()
      // XXX TODO: assert that initializer yields an i32
      var size = read_varuint32()
      d.data = read_bytes(size)
      return d
    }

  }

  function renderSectionsToJS(sections) {
    console.log("---- RENDERING CODE ----")
    var src = []
    // Basic setup, helper functions, etc.

    // XXX TODO: declare globals.

    // XXX TODO: declare memory.

    // XXX TODO: declare tables.

    // Render the code for each function.

    sections[SECTIONS.CODE].forEach(function(f, idx) {
      Array.prototype.push.apply(src, f.code.header_lines)
      Array.prototype.push.apply(src, f.code.body_lines)
      Array.prototype.push.apply(src, f.code.footer_lines)
    })

    // Return the exports as an object.
    src.push("return {")
    var exports = sections[SECTIONS.EXPORT]
    exports.forEach(function(e, idx) {
      var ref = "trap()"
      switch (e.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          ref = "F" + e.index
          break
        case EXTERNAL_KINDS.GLOBAL:
          ref = "G" + e.index
          break
        case EXTERNAL_KINDS.MEMORY:
          ref = "M" + e.index
          break
        case EXTERNAL_KINDS.TABLE:
          ref = "T" + e.index
          break
      }
      src.push("  '" + e.field + "' :" + ref + (idx == exports.length - 1 ? "" : ","))
    })
    src.push("}")

    // That's it!  Compile it as a function and return it.
    var code = src.join("\n")
    console.log("---")
    console.log(code)
    console.log("---")
    return new Function('imports', code)
  }


  //
  // Various misc helper functions.
  //

  function trap() {
    throw new RuntimeError()
  }

  function assertIsDefined(obj) {
    if (typeof obj === "undefined") {
      throw new TypeError()
    }
  }

  function assertIsInstance(obj, Cls) {
    if (!obj instanceof Cls) {
      throw new TypeError()
    }
  }

  function assertIsType(obj, typstr) {
    if (typeof obj !== typstr) {
      throw new TypeError()
    }
  }

  function ToWebAssemblyValue(jsValue, kind) {
    switch (kind) {
      case "i32":
        return jsValue|0
      case "i64":
        throw new TypeError()
      case "f32":
        return +jsValue
      case "f64":
        return +jsValue
      default:
        throw new TypeError()
    }
  }

  function ToNonWrappingUint32(v) {
    // XXX TODO: throw RangeError if > UINT32_MAX
    return v >>> 0
  }

  function arrayBufferFromBufferSource(source) {
    if (source instanceof ArrayBuffer) {
      return source
    }
    const viewClasses = [
      Int8Array,
      Int16Array,
      Int32Array,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Uint8ClampedArray,
      Float32Array,
      Float64Array,
      DataView
    ]
    for (var i = 0; i < viewClasses.length; i++) {
      if (source instanceof viewClasses[i]) {
        return source.buffer
      }
    }
    return null
  }

  return WebAssembly

})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this);