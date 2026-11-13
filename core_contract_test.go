package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// Validate recorded requests against the published 0.1.21 schema, independently
// of the mock's implementation. In particular `if: done` must never be emitted.
func checkCoreContract(t *testing.T, requests []coreRequest) {
	t.Helper()
	data, err := os.ReadFile("testdata/herdr-core/released.openrpc.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	methods := map[string]map[string]any{}
	for _, item := range document["methods"].([]any) {
		m := item.(map[string]any)
		methods[m["name"].(string)] = m
	}
	for _, req := range requests {
		method, ok := methods[req.Method]
		if !ok {
			t.Fatalf("method absent from official schema: %s", req.Method)
		}
		parameters := map[string]map[string]any{}
		for _, item := range method["params"].([]any) {
			p := item.(map[string]any)
			name := p["name"].(string)
			parameters[name] = p["schema"].(map[string]any)
			if p["required"] == true {
				if _, ok := req.Params[name]; !ok {
					t.Fatalf("%s missing required parameter %s", req.Method, name)
				}
			}
		}
		for name, value := range req.Params {
			schema, ok := parameters[name]
			if !ok {
				t.Fatalf("unknown %s parameter %s", req.Method, name)
			}
			if err := checkSchemaValue(document, schema, value); err != nil {
				t.Fatalf("%s.%s violates official schema: %v", req.Method, name, err)
			}
		}
	}
}
func checkSchemaValue(document, schema map[string]any, value any) error {
	if ref, ok := schema["$ref"].(string); ok {
		var target any = document
		for _, key := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			target = target.(map[string]any)[key]
		}
		return checkSchemaValue(document, target.(map[string]any), value)
	}
	if alternatives, ok := schema["anyOf"].([]any); ok {
		for _, candidate := range alternatives {
			if checkSchemaValue(document, candidate.(map[string]any), value) == nil {
				return nil
			}
		}
		return fmt.Errorf("value %v matches none of anyOf", value)
	}
	if choices, ok := schema["enum"].([]any); ok {
		for _, candidate := range choices {
			if candidate == value {
				return nil
			}
		}
		return fmt.Errorf("value %v is outside enum %v", value, choices)
	}
	validType := func(kind string) bool {
		switch kind {
		case "null":
			return value == nil
		case "string":
			_, ok := value.(string)
			return ok
		case "boolean":
			_, ok := value.(bool)
			return ok
		case "number", "integer":
			v, ok := value.(float64)
			return ok && (kind != "integer" || v == float64(int64(v)))
		case "object":
			_, ok := value.(map[string]any)
			return ok
		case "array":
			_, ok := value.([]any)
			return ok
		}
		return false
	}
	switch kind := schema["type"].(type) {
	case string:
		if !validType(kind) {
			return fmt.Errorf("expected %s, got %T", kind, value)
		}
	case []any:
		valid := false
		for _, k := range kind {
			valid = valid || validType(k.(string))
		}
		if !valid {
			return fmt.Errorf("expected %v, got %T", kind, value)
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		for _, item := range value.([]any) {
			if err := checkSchemaValue(document, items, item); err != nil {
				return err
			}
		}
	}
	if additional, ok := schema["additionalProperties"].(map[string]any); ok {
		for _, item := range value.(map[string]any) {
			if err := checkSchemaValue(document, additional, item); err != nil {
				return err
			}
		}
	}
	return nil
}
