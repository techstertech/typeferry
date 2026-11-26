//! Authoring macros for the TypeFerry Rust runtime — equivalent to the
//! TS / Python decorators.
//!
//! # Example
//!
//! ```ignore
//! use typeferry_macros::{method, register};
//! use typeferry_runtime::{ClientNode, BoxResult};
//! use serde_json::{Value, json};
//! use std::sync::Arc;
//!
//! #[method]
//! async fn echo(_node: Arc<ClientNode>, params: Value) -> BoxResult {
//!     Ok(params)
//! }
//!
//! #[method(name = "users.me", protected)]
//! async fn me(node: Arc<ClientNode>, _params: Value) -> BoxResult {
//!     Ok(json!(node.uuid()))
//! }
//!
//! #[method(cached(max_age_ms = 30_000))]
//! async fn cached_read(_node: Arc<ClientNode>, _p: Value) -> BoxResult {
//!     Ok(json!("slow"))
//! }
//!
//! fn wire(server: &Arc<typeferry_runtime::Server>) {
//!     register!(server, [echo, me, cached_read]);
//!     // or with a namespace prefix:
//!     register!(server, namespace = "v1", [echo]);
//! }
//! ```

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{quote, quote_spanned};
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{Expr, Ident, ItemFn, Lit, LitStr, Meta, Token, parse_macro_input};

// ---------------------------------------------------------------------------
// `#[method]` attribute
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MethodAttrs {
    name: Option<LitStr>,
    protected: bool,
    sensitive: bool,
    cached: bool,
    max_age_ms: Option<Expr>,
}

impl Parse for MethodAttrs {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let mut attrs = MethodAttrs::default();
        if input.is_empty() {
            return Ok(attrs);
        }
        let metas = Punctuated::<Meta, Token![,]>::parse_terminated(input)?;
        for meta in metas {
            match &meta {
                Meta::Path(path) if path.is_ident("protected") => {
                    attrs.protected = true;
                }
                Meta::Path(path) if path.is_ident("sensitive") => {
                    attrs.sensitive = true;
                }
                Meta::Path(path) if path.is_ident("cached") => {
                    attrs.cached = true;
                }
                Meta::List(list) if list.path.is_ident("cached") => {
                    attrs.cached = true;
                    // Parse ``cached(max_age_ms = <expr>)``.
                    let nested: Punctuated<Meta, Token![,]> =
                        list.parse_args_with(Punctuated::parse_terminated)?;
                    for n in nested {
                        if let Meta::NameValue(nv) = &n
                            && nv.path.is_ident("max_age_ms")
                        {
                            attrs.max_age_ms = Some(nv.value.clone());
                        }
                    }
                }
                Meta::NameValue(nv) if nv.path.is_ident("name") => {
                    if let Expr::Lit(lit) = &nv.value
                        && let Lit::Str(s) = &lit.lit
                    {
                        attrs.name = Some(s.clone());
                    }
                }
                other => {
                    return Err(syn::Error::new(
                        other.span(),
                        "unsupported #[method] option (expected: name = \"...\", protected, cached, cached(max_age_ms = N))",
                    ));
                }
            }
        }
        Ok(attrs)
    }
}

/// `#[method]` — register a function as an RPC handler.
///
/// Options: `name = "wire.name"`, `protected`, `cached`,
/// `cached(max_age_ms = N)`.
#[proc_macro_attribute]
pub fn method(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attrs = parse_macro_input!(attr as MethodAttrs);
    let func = parse_macro_input!(item as ItemFn);

    if func.sig.asyncness.is_none() {
        return syn::Error::new_spanned(func.sig.fn_token, "#[method] requires an async fn")
            .to_compile_error()
            .into();
    }

    let fn_name = &func.sig.ident;
    let wire_name_expr = match &attrs.name {
        Some(lit) => quote! { #lit },
        None => quote! { stringify!(#fn_name) },
    };
    let protected = attrs.protected;
    let sensitive = attrs.sensitive;
    let cached = attrs.cached;
    let max_age_ms = match &attrs.max_age_ms {
        Some(expr) => quote! { Some(#expr) },
        None => quote! { None },
    };

    let register_fn = Ident::new(
        &format!("__typeferry_register_{fn_name}"),
        Span::call_site(),
    );

    let expanded = quote! {
        #func

        #[doc(hidden)]
        #[allow(non_snake_case)]
        pub fn #register_fn(
            server: &::std::sync::Arc<::typeferry_runtime::Server>,
            namespace: &str,
        ) {
            let base = #wire_name_expr;
            let wire_name = if namespace.is_empty() {
                base.to_string()
            } else {
                ::std::format!("{}.{}", namespace, base)
            };
            let handler: ::typeferry_runtime::RpcHandler = ::std::sync::Arc::new(
                |node, params| ::std::boxed::Box::pin(#fn_name(node, params))
            );
            let opts = ::typeferry_runtime::MethodOptions {
                protected: #protected,
                sensitive: #sensitive,
                cache: #cached,
                max_age_ms: #max_age_ms,
                middleware: ::std::vec::Vec::new(),
                schema: ::std::option::Option::None,
            };
            server.add_method(&wire_name, handler, opts);
        }
    };

    expanded.into()
}

// ---------------------------------------------------------------------------
// `register!` function-like macro
// ---------------------------------------------------------------------------

struct RegisterInput {
    server: Expr,
    namespace: Option<LitStr>,
    methods: Vec<Ident>,
}

impl Parse for RegisterInput {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let server: Expr = input.parse()?;
        input.parse::<Token![,]>()?;

        let mut namespace: Option<LitStr> = None;

        // Optional ``namespace = "prefix"``.
        let lookahead = input.lookahead1();
        if lookahead.peek(Ident) {
            let ident: Ident = input.fork().parse()?;
            if ident == "namespace" {
                let _: Ident = input.parse()?;
                input.parse::<Token![=]>()?;
                namespace = Some(input.parse()?);
                input.parse::<Token![,]>()?;
            }
        }

        // ``[fn1, fn2, ...]``
        let content;
        syn::bracketed!(content in input);
        let methods: Punctuated<Ident, Token![,]> = Punctuated::parse_terminated(&content)?;

        Ok(Self {
            server,
            namespace,
            methods: methods.into_iter().collect(),
        })
    }
}

/// `register!(server, [method_a, method_b])` — batch-register every
/// `#[method]`-decorated function in the list. Optionally pass
/// `namespace = "prefix"` to prefix every wire name.
#[proc_macro]
pub fn register(input: TokenStream) -> TokenStream {
    let RegisterInput {
        server,
        namespace,
        methods,
    } = parse_macro_input!(input as RegisterInput);

    let namespace_expr = match &namespace {
        Some(lit) => quote! { #lit },
        None => quote! { "" },
    };

    let mut calls = TokenStream2::new();
    for ident in &methods {
        let register_fn = Ident::new(&format!("__typeferry_register_{ident}"), ident.span());
        calls.extend(quote_spanned! {ident.span()=>
            #register_fn(&__typeferry_server, __typeferry_namespace);
        });
    }

    let expanded = quote! {{
        let __typeferry_server: &::std::sync::Arc<::typeferry_runtime::Server> = &#server;
        let __typeferry_namespace: &str = #namespace_expr;
        #calls
    }};

    expanded.into()
}
