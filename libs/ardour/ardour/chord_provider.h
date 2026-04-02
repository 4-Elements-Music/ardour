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

#pragma once

#include <vector>
#include <string>

namespace ARDOUR {

class ScaleProvider;

class ChordProvider
{
  public:
	ChordProvider () {}
	virtual ~ChordProvider() {}

	virtual bool get_midi_chord (int root_pitch, std::vector<int>& pitches) const = 0;
	virtual void set_scale_provider (ScaleProvider const * sp) {}

	/* vector values are semitone intervals from root */
	struct TET12Chord : std::vector<int> {
		std::string name;
	};

	typedef std::vector<TET12Chord> TET12Chords;
	static TET12Chords tet12_chords;
	static void build_12tet_chords ();

	enum TET12Intervals {
		ROOT = 0,
		FLAT_SECOND = 1,
		SECOND = 2,
		MINOR_THIRD = 3,
		MAJOR_THIRD = 4,
		FOURTH = 5,
		FLAT_FIFTH = 6,
		FIFTH = 7,
		SHARP_FIFTH = 8,
		SIXTH = 9,
		DOM_SEVENTH = 10,
		MAJ_SEVENTH = 11,
		//convenient aliases
		NINTH = SECOND,
		ELEVENTH = FOURTH,
		THIRTEENTH = SIXTH,
		DOUBLE_FLAT_SEVENTH = SIXTH,
		SHARP_NINTH = MINOR_THIRD,
	};
};

}
