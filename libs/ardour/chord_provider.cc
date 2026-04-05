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
#include <cassert>

#include "ardour/chord_provider.h"
#include "ardour/parameter_descriptor.h"

#include "pbd/i18n.h"

using namespace ARDOUR;

ChordProvider::ChordNameToIntervals ChordProvider::tet12_chords;
ChordProvider::IntervalsToChordName ChordProvider::tet12_names;

static int64_t
hash_intervals (ChordProvider::Intervals const & intervals)
{
	assert (!intervals.empty());

	const int64_t max_interval = 23; /* maximum possible interval */
	int64_t mult = max_interval;
	int64_t ret = intervals[0];

	for (auto n = 1U; n < intervals.size(); ++n) {
		assert (intervals[n] < max_interval);

		ret += mult * intervals[n];
		mult *= max_interval;
	}

	return ret;
}

template<typename...Names>
void
ChordProvider::register_12tet_chord (Intervals const & intervals, std::string const & canonical_name, Names...chord_names)
{
	tet12_names.insert (std::make_pair (hash_intervals (intervals), canonical_name));
	tet12_chords.insert (std::make_pair (canonical_name, intervals));

	for (auto & chord_name : { chord_names... } ) {
		tet12_chords.insert (std::make_pair (chord_name, intervals));
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
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorNinth},                   _("Add9"), _("add9"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MajorNinth},                   _("Minor Add9"), _("min/9"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSixth},                   _("Major 6th"), _("maj6"));
	register_12tet_chord ({Unison, MinorThird, PerfectFifth, MajorSixth},                   _("Minor 6th"), _("min6"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSixth, MajorNinth},       _("Major 6/9"), _("maj6/9"));
	register_12tet_chord ({Unison, MajorSecond, PerfectFifth, MajorSeventh},                _("Sus2/7"), _("sus2/7"));
	register_12tet_chord ({Unison, PerfectFourth, PerfectFifth, MajorSeventh},              _("Sus4/7"), _("sus4/7"));

	/* Hexachords */

	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MinorSeventh, MajorNinth, P11}, _("Dominant 11th"), _("dom11"));
	register_12tet_chord ({Unison, MajorThird, PerfectFifth, MajorSeventh, MajorNinth, M13}, _("Major 13th"), _("maj13"));

}

static inline
int
pitch_to_pitch_class (int pitch)
{
	return pitch % 12;
}

static inline
int
canonical_interval (int interval)
{
	return (((interval % 12) + 12) % 12);
}

static std::vector<int>
to_pitch_class (std::vector<int> const & pitches)
{
	/* It migbt seem obvious to use a std::set<> here, but the pitch
	   classes we return must be in the same order as the pitches we are
	   provided, which std::set<> makes hard to do.
	*/
	std::vector<int> v;
	int mask = 0;
	for (int n : pitches) {
		int pc = pitch_to_pitch_class (n);
		if (!(mask & (1<<pc))) {
			v.push_back (pc);
			mask |= (1<<pc);
		}
	}
	return v;
}

static ChordProvider::Intervals
to_intervals (std::vector<int> const & pcs, int root)
{
	ChordProvider::Intervals iv;
	for (int pc : pcs) {
		int d = canonical_interval (pc - root);
		iv.push_back (d);
	}
	return iv;
}

std::string
ChordProvider::identify_chord (std::vector<int> const & pitches)
{
	if (pitches.empty()) {
		return "";
	}

	if (pitches.size() < 2) {
		return _("Not a chord");
		return "";
	}

	if (tet12_names.empty() ){
		build_12tet_chords ();
	}

	int bass = *std::min_element (pitches.begin(), pitches.end());
	int bass_class = pitch_to_pitch_class (bass);
	std::vector<int> pcs = to_pitch_class (pitches);

	for (int root : pcs) {
		auto intervals = to_intervals (pcs, root);
		int64_t hashed = hash_intervals (intervals);;

		for (auto const & [hashed_intervals,name] : tet12_names) {

			if (hashed_intervals == hashed) {
				std::string ret;
				/* translate note names but no enharmonics */
				ret = ParameterDescriptor::midi_note_name (root, true, false, false) + ' ';
				ret += name;

				if (bass_class != root) {
					/* slash chord */
					ret += '/';
					ret += ParameterDescriptor::midi_note_name (bass_class, true, false, false);
				}
				return ret;
			}
		}
	}

	return _("Unknown");
}
