#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <map>

// Normalize intervals: sort, remove duplicates, reduce to within one octave (0-11),
// and ensure root (0) is present
std::vector<int> normalizeIntervals(std::vector<int> intervals) {
    // Reduce to mod 12 (one octave)
    for (auto& i : intervals) {
        i = ((i % 12) + 12) % 12;
    }

    // Sort and deduplicate
    std::sort(intervals.begin(), intervals.end());
    intervals.erase(std::unique(intervals.begin(), intervals.end()), intervals.end());

    return intervals;
}

// Build the chord lookup table
// Keys are sorted interval sets (relative to root = 0)
std::map<std::vector<int>, std::string> buildChordTable() {
    return {
        // Triads
        {{0, 4, 7},         "Major"},
        {{0, 3, 7},         "Minor"},
        {{0, 3, 6},         "Diminished"},
        {{0, 4, 8},         "Augmented"},
        {{0, 5, 7},         "Sus4"},
        {{0, 2, 7},         "Sus2"},
        {{0, 7},            "Power (5th)"},

        // Seventh chords
        {{0, 4, 7, 11},     "Major 7th"},
        {{0, 4, 7, 10},     "Dominant 7th"},
        {{0, 3, 7, 10},     "Minor 7th"},
        {{0, 3, 7, 11},     "Minor/Major 7th"},
        {{0, 3, 6, 10},     "Half-Diminished 7th (m7b5)"},
        {{0, 3, 6, 9},      "Diminished 7th"},
        {{0, 4, 8, 10},     "Augmented 7th"},
        {{0, 4, 8, 11},     "Augmented Major 7th"},

        // Extended chords
        {{0, 4, 7, 10, 14}, "Dominant 9th"},
        {{0, 4, 7, 11, 14}, "Major 9th"},
        {{0, 3, 7, 10, 14}, "Minor 9th"},
        {{0, 4, 7, 10, 14, 17}, "Dominant 11th"},
        {{0, 4, 7, 11, 14, 21}, "Major 13th"},

        // Added tone chords
        {{0, 4, 7, 14},     "Add9"},
        {{0, 3, 7, 14},     "Minor Add9"},
        {{0, 4, 7, 9},      "Major 6th"},
        {{0, 3, 7, 9},      "Minor 6th"},
        {{0, 4, 7, 9, 14},  "Major 6/9"},
    };
}

std::string identifyChord(const std::vector<int>& rawIntervals) {
    if (rawIntervals.empty()) return "Unknown (no notes)";

    auto intervals = normalizeIntervals(rawIntervals);

    // Ensure root is present
    if (intervals.empty() || intervals[0] != 0) {
        intervals.insert(intervals.begin(), 0);
    }

    const auto chordTable = buildChordTable();

    // 1. Direct lookup
    auto it = chordTable.find(intervals);
    if (it != chordTable.end()) {
        return it->second;
    }

    // 2. Try inversions: rotate intervals so each note becomes the "root"
    for (size_t i = 1; i < intervals.size(); i++) {
        int newRoot = intervals[i];
        std::vector<int> inverted;
        for (int interval : intervals) {
            inverted.push_back(((interval - newRoot) % 12 + 12) % 12);
        }
        std::sort(inverted.begin(), inverted.end());

        auto inv_it = chordTable.find(inverted);
        if (inv_it != chordTable.end()) {
            return inv_it->second + " (inversion)";
        }
    }

    return "Unknown chord";
}

// --- Example usage ---
int main() {
    struct TestCase {
        std::vector<int> intervals;
        std::string description;
    };

    std::vector<TestCase> tests = {
        {{0, 4, 7},         "C Major triad"},
        {{0, 3, 7},         "C Minor triad"},
        {{0, 4, 7, 11},     "C Major 7th"},
        {{0, 4, 7, 10},     "C Dominant 7th"},
        {{0, 3, 6, 9},      "C Diminished 7th"},
        {{3, 7, 12},        "C Major (1st inversion: E-G-C)"},
        {{0, 4, 8},         "C Augmented"},
        {{0, 2, 7},         "C Sus2"},
        {{0, 4, 7, 10, 14}, "C Dominant 9th"},
        {{0, 1, 2, 3},      "Cluster (unknown)"},
    };

    for (const auto& test : tests) {
        std::cout << test.description << ": " << identifyChord(test.intervals) << "\n";
    }

    return 0;
}
