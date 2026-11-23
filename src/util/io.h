/*
Copyright (c) 2019 Microsoft Corporation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.

Author: Leonardo de Moura
*/
#pragma once
#include <cstdio>
#include "runtime/exception.h"
#include "runtime/object.h"
#include "runtime/string_ref.h"

namespace lean {
struct wasm_exit_exception : std::exception {
    int m_code;
    explicit wasm_exit_exception(int code) noexcept : m_code(code) {}
    char const * what() const noexcept override { return "wasm_exit"; }
};

inline void lean_log_write(unsigned level, char const * category, char const * message) {
    static char const * const names[] = {"error", "warning", "info", "debug"};
    std::fprintf(stderr, "%s: [%s] %s\n", names[level < 4 ? level : 0], category ? category : "lean", message ? message : "");
    std::fflush(stderr);
}
inline bool lean_wasm_trace_enabled() {
    static int cached = -1;
    if (cached < 0) cached = std::getenv("LEAN_WASM_TRACE") ? 1 : 0;
    return cached == 1;
}
inline void lean_trace_write(char const * category, char const * message) {
    if (lean_wasm_trace_enabled()) lean_log_write(2, category, message);
}

extern "C" object* lean_io_error_to_string(object * err);

template<typename T> T get_io_result(object * o) {
    if (io_result_is_error(o)) {
        object * err_obj = io_result_get_error(o);
        inc(err_obj);
        dec(o);
        string_ref error(lean_io_error_to_string(err_obj));
        std::string msg = error.to_std_string();
        lean_trace_write("io", msg.c_str());
        throw exception(msg);
    } else {
        T r(io_result_get_value(o), true);
        dec(o);
        return r;
    }
}

inline void consume_io_result(object * o) {
    if (io_result_is_error(o)) {
        object * err_obj = io_result_get_error(o);
        inc(err_obj);
        dec(o);
        string_ref error(lean_io_error_to_string(err_obj));
        throw exception(error.to_std_string());
    }
    dec(o);
}

template<typename T> T get_io_scalar_result(object * o) {
    if (io_result_is_error(o)) {
        object * err_obj = io_result_get_error(o);
        inc(err_obj);
        dec(o);
        string_ref error(lean_io_error_to_string(err_obj));
        throw exception(error.to_std_string());
    } else {
        T r = unbox(io_result_get_value(o));
        dec(o);
        return r;
    }
}

}
