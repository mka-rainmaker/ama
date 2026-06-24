package com.app;

public record UserEvent(String id, Payload payload) implements Event {
	public String label() {
		return payload.name();
	}
}
