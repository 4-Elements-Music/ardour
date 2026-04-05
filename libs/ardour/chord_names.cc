#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <map>

std::map<std::vector<int>, std::string> buildChordTable() {
    return {
        {{0, 4, 7},             "Major"},
        {{0, 3, 7},             "Minor"},
        {{0, 3, 6},             "Diminished"},
        {{0, 4, 8},             "Augmented"},
        {{0, 5, 7},             "Sus4"},
        {{0, 2, 7},             "Sus2"},
        {{0, 7},                "Power (5th)"},
        {{0, 4, 7, 11},         "Major 7th"},
        {{0, 4, 7, 10},         "Dominant 7th"},
        {{0, 3, 7, 10},         "Minor 7th"},
        {{0, 3, 7, 11},         "Minor/Major 7th"},
        {{0, 3, 6, 10},         "Half-Diminished 7th (m7b5)"},
        {{0, 3, 6, 9},          "Diminished 7th"},
        {{0, 4, 8, 10},         "Augmented 7th"},
        {{0, 4, 8, 11},         "Augmented Major 7th"},
        {{0, 4, 7, 10, 14},     "Dominant 9th"},
        {{0, 4, 7, 11, 14},     "Major 9th"},
        {{0, 3, 7, 10, 14},     "Minor 9th"},
        {{0, 4, 7, 10, 14, 17}, "Dominant 11th"},
        {{0, 4, 7, 11, 14, 21}, "Major 13th"},
        {{0, 4, 7, 14},         "Add9"},
        {{0, 3, 7, 14},         "Minor Add9"},
        {{0, 4, 7, 9},          "Major 6th"},
        {{0, 3, 7, 9},          "Minor 6th"},
        {{0, 4, 7, 9, 14},      "Major 6/9"},
    };
}

std::string lookupWithInversions(std::vector<int> intervals,
                                  const std::map<std::vector<int>, std::string>& table,
                                  bool allowInversions) {
    auto it = table.find(intervals);
    if (it != table.end()) return it->second;

    if (!allowInversions) return "";

    for (size_t i = 1; i < intervals.size(); i++) {
        int newRoot = intervals[i];
        std::vector<int> inverted;
        for (int v : intervals)
            inverted.push_back(((v - newRoot) % 12 + 12) % 12);
        std::sort(inverted.begin(), inverted.end());
        auto inv_it = table.find(inverted);
        if (inv_it != table.end())
            return inv_it->second + " (inversion)";
    }
    return "";
}

std::string identifyChord(const std::vector<int>& rawIntervals) {
    if (rawIntervals.empty()) return "Unknown (no notes)";

    const auto chordTable = buildChordTable();

    // Pass 1: preserve extended intervals, shift lowest note to root 0
    {
        auto intervals = rawIntervals;
        std::sort(intervals.begin(), intervals.end());
        intervals.erase(std::unique(intervals.begin(), intervals.end()), intervals.end());
        int root = intervals[0];
        for (auto& i : intervals) i -= root;
        auto result = lookupWithInversions(intervals, chordTable, false);
        if (!result.empty()) return result;
    }

    // Pass 2: mod-12 normalize, then try direct + inversions
    {
        auto intervals = rawIntervals;
        for (auto& i : intervals) i = ((i % 12) + 12) % 12;
        std::sort(intervals.begin(), intervals.end());
        intervals.erase(std::unique(intervals.begin(), intervals.end()), intervals.end());
        if (intervals[0] != 0) intervals.insert(intervals.begin(), 0);
        auto result = lookupWithInversions(intervals, chordTable, true);
        if (!result.empty()) return result;
    }

    return "Unknown chord";
}

int main() {
    struct TestCase {
        std::vector<int> intervals;
        std::string description;
        std::string expected;
    };

    std::vector<TestCase> tests = {
        // Root position chords
        {{0, 4, 7},         "C Major triad",                        "Major"},
        {{0, 3, 7},         "C Minor triad",                        "Minor"},
        {{0, 4, 7, 11},     "C Major 7th",                          "Major 7th"},
        {{0, 4, 7, 10},     "C Dominant 7th",                       "Dominant 7th"},
        {{0, 3, 6, 9},      "C Diminished 7th",                     "Diminished 7th"},
        {{0, 4, 8},         "C Augmented",                          "Augmented"},
        {{0, 2, 7},         "C Sus2",                               "Sus2"},
        {{0, 4, 7, 10, 14}, "C Dominant 9th",                       "Dominant 9th"},
        // Inversion: intervals from bass note that don't reduce to root position
        // E-G-C as relative intervals from E: {0, 3, 8}
        {{0, 3, 8},         "C Major 1st inv (E bass: 0,+3,+8)",    "Major (inversion)"},
        // Same chord doubled at octave - mod-12 should still resolve
        {{4, 7, 12},        "C Major pitches with E bass (4,7,12)", "Major"},
        // Unknown
        {{0, 1, 2, 3},      "Cluster (unknown)",                    "Unknown chord"},
    };

    int passed = 0, failed = 0;
    for (const auto& test : tests) {
        std::string result = identifyChord(test.intervals);
        bool ok = (result == test.expected);
        std::cout << (ok ? "[PASS]" : "[FAIL]") << " " << test.description
                  << "\n       Expected: " << test.expected
                  << "\n       Got:      " << result << "\n\n";
        ok ? passed++ : failed++;
    }

    std::cout << "Results: " << passed << " passed, " << failed << " failed.\n";
    return failed > 0 ? 1 : 0;
}
