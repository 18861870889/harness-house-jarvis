#!/usr/bin/env python3
"""
Preference Analyzer — cronjob script that analyzes command patterns and
generates automation suggestions, saving them to Obsidian.

Run daily to:
  1. Load command observations from PreferenceManager
  2. Analyze patterns (top devices, time patterns, room patterns)
  3. Generate automation suggestions
  4. Save to Obsidian preferences note
  5. Format suggestions for LLM context injection
"""
from __future__ import annotations

import json
import os
import sys
import time

# Add scripts dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preference_manager import PreferenceManager


def main():
    """Main entry point for cronjob execution."""
    pref = PreferenceManager()
    
    # Analyze patterns
    patterns = pref.analyze_patterns()
    
    # Save to Obsidian
    note_path = pref.save_to_obsidian()
    
    # Get LLM context
    context = pref.get_context_for_llm()
    
    # Output summary
    print(f"[PreferenceAnalyzer] {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Total commands: {patterns['total_commands']}")
    print(f"  Top devices: {len(patterns['top_devices'])}")
    print(f"  Time patterns: {len(patterns['time_patterns'])}")
    print(f"  Suggestions: {len(patterns['suggestions'])}")
    print(f"  Obsidian note: {note_path}")
    print(f"  LLM context: {context[:200]}")
    
    # Write suggestions to file for notification
    if patterns["suggestions"]:
        suggestions_path = os.path.join(
            os.environ.get("HOME_CONTROL_DATA", os.path.expanduser("~/harness-house-jarvis/data")),
            "preference-suggestions.json",
        )
        os.makedirs(os.path.dirname(suggestions_path), exist_ok=True)
        with open(suggestions_path, "w") as f:
            json.dump({
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "suggestions": patterns["suggestions"],
                "context": context,
            }, f, ensure_ascii=False, indent=2)
        
        print(f"\n💡 自动化建议:")
        for s in patterns["suggestions"]:
            conf_pct = int(s.get("confidence", 0) * 100)
            print(f"  - {s['description']} (置信度 {conf_pct}%)")


if __name__ == "__main__":
    main()
