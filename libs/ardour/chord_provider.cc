/*
 * Copyright (C) 2026 Paul Davis <paul@linuxaudiosystems.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include <algorithm>

#include "ardour/chord_provider.h"
#include "pbd/i18n.h"

using namespace ARDOUR;

ChordProvider::ChordNameToIntervals ChordProvider::tet12_chords;
ChordProvider::IntervalsToChordName ChordProvider::tet12_names;

template<typename...Names>
void
ChordProvider::register_12tet_chord (Intervals const & intervals, std::string const & canonical_name, Names...chord_names)
{
	tet12_names.insert (std::make_pair (intervals, canonical_name));
	tet12_chords[canonical_name] = intervals;
	for (auto & chord_name : { chord_names... } ) {
		tet12_chords[chord_name] = intervals;
	}
}

void
ChordProvider::build_12tet_chords ()
{
	register_12tet_chord ({Unison, PerfectFifth},                                   _("Power (5th)"), _("pow5"));

	/* triads */

	register_12tet_chord ({Unison, MajorThird, PerfectFifth},                       _("Major"), _("maj"), _("major"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth},                       _("Minor"), _("min"), _("minor"));
	register_12tet_chord ({Unison, MinorThird, 6},                                  _("Diminished"), _("dim"));
	register_12tet_chord ({Unison, MajorThird, MinorSixth},                         _("Augmented"), _("aug"));
	register_12tet_chord ({Unison, PerfectFourth, PerfectFifth},                    _("Sus4"), _("sus4"));
	register_12tet_chord ({Unison, MajorSecond, PerfectFifth},                      _("Sus2"), _("sus2"));

	/* tetrads */

	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSeventh},         _("Major 7th"), _("maj7"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MinorSeventh},         _("Dominant 7th"), _("dom7"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MinorSeventh},         _("Minor 7th"), _("min7"));
	register_12tet_chord ({Unison, MinorThird, DiminishedFifth, MinorSeventh},      _("Half Diminished 7th"), _("halfdim7"));
	register_12tet_chord ({Unison, MinorThird, DiminishedFifth, DiminishedSeventh}, _("Diminished 7th"), _("dim7"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MajorSeventh},         _("Minor/Major 7th"), _("min/maj7"));
	register_12tet_chord ({Unison, MinorThird, AugmentedFifth, MajorSeventh},       _("Major 7th/flat 5"), _("maj7b5"));
	register_12tet_chord ({Unison, MinorThird, AugmentedFifth, MajorSeventh},       _("Major 7th/sharp 5"), _("maj7#5"));
	register_12tet_chord ({Unison, MinorThird, DiminishedFifth, MinorSeventh},      _("Half-Diminished 7th"), _("m7b5"));
	register_12tet_chord ({Unison, MinorThird, DiminishedFifth, MajorSixth},        _("Diminished 7th"), _("dim7"));
	register_12tet_chord ({Unison, MajorThird, MinorSixth, MinorSeventh},           _("Augmented 7th"), _("aug7"));
	register_12tet_chord ({Unison, MajorThird, MinorSixth, MajorSeventh},           _("Augmented Major 7th"), _("aug-dom-7"));

	/* Pentachords */

	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MinorSeventh, MajorNinth},     _("Dominant 9th"), _("dom9"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSeventh, MajorNinth},     _("Major 9th"), _("9"), _("maj9"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MinorSeventh, MajorNinth},     _("Minor 9th"), _("min9"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MinorSeventh, MajorNinth, P11}, _("Dominant 11th"), _("dom11"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSeventh, MajorNinth, M13}, _("Major 13th"), _("maj13"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorNinth},                   _("Add9"), _("add9"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MajorNinth},                   _("Minor Add9"), _("min/9"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSixth},                   _("Major 6th"), _("maj6"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MajorSixth},                   _("Minor 6th"), _("min6"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSixth, MajorNinth},       _("Major 6/9"), _("maj6/9"));
	register_12tet_chord ({Unison, MajorSecond, PerfectFifth, MajorSeventh},                _("Sus2/7"), _("sus2/7"));
	register_12tet_chord ({Unison, PerfectFourth, PerfectFifth, MajorSeventh},              _("Sus4/7"), _("sus4/7"));

}

static std::string
lookup_with_inversions (ChordProvider::Intervals const & intervals, ChordProvider::IntervalsToChordName const & table, bool allow_inversions)
{
	auto it = table.find (intervals);
	if (it != table.end()) {
		return it->second;
	}

	if (!allow_inversions) {
		return "";
	}

	for (size_t i = 1; i < intervals.size(); i++) {
		int newRoot = intervals[i];
		std::vector<int> inverted;
		for (int v : intervals) {
			inverted.push_back(((v - newRoot) % 12 + 12) % 12);
		}
		std::sort (inverted.begin(), inverted.end());
		auto inv_it = table.find(inverted);
		if (inv_it != table.end()) {
			return inv_it->second + " (inversion)";
		}
	}
	return "";
}

std::string
ChordProvider::identify_chord (Intervals const & raw_intervals)
{
	if (raw_intervals.empty()) {
		return "Unknown (no notes)";
	}

	if (tet12_names.empty() ){
		build_12tet_chords ();
	}

	// Pass 1: preserve extended intervals, shift lowest note to root 0
	{
		auto intervals = raw_intervals;
		std::sort (intervals.begin(), intervals.end());
		intervals.erase (std::unique (intervals.begin(), intervals.end()), intervals.end());
		int root = intervals[0];
		for (auto& i : intervals) {
			i -= root;
		}
		auto result = lookup_with_inversions (intervals, tet12_names, false);
		if (!result.empty()) {
			return result;
		}
	}

	// Pass 2: mod-12 normalize, then try direct + inversions
	{
		auto intervals = raw_intervals;
		for (auto& i : intervals) {
			i = ((i % 12) + 12) % 12;
		}
		std::sort (intervals.begin(), intervals.end());
		intervals.erase (std::unique (intervals.begin(), intervals.end()), intervals.end());
		if (intervals[0] != 0) {
			intervals.insert (intervals.begin(), 0);
		}
		auto result = lookup_with_inversions (intervals, tet12_names, true);
		if (!result.empty()) {
			return result;
		}
	}

	return "Unknown chord";
}
