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
#include <map>

namespace ARDOUR {

class ScaleProvider;

class ChordProvider
{
  public:
	ChordProvider () {}
	virtual ~ChordProvider() {}

	virtual bool get_midi_chord (int root_pitch, std::vector<int>& pitches) const = 0;
	virtual void set_scale_provider (ScaleProvider const * sp) {}

	typedef std::map<std::string,std::vector<int> > TET12Chords;
	static TET12Chords tet12_chords;
	static void build_12tet_chords ();
	template<typename...Names> static void register_12tet_chord (std::vector<int> const intervals, Names...chord_names);

	enum TET12Intervals {
		Unison = 0,
		MinorSecond = 1,
		MajorSecond = 2,
		MinorThird = 3,
		MajorThird = 4,
		PerfectFourth = 5,
		Tritone = 6,
		PerfectFifth = 7,
		MinorSixth = 8,
		MajorSixth = 9,
		MinorSeventh = 10,
		MajorSeventh = 11,
		PerfectOctave = 12,

		/* aliases set #1 */

		P0 = PerfectOctave,
		m2 = MinorSecond,
		M2 = MajorSecond,
		m3 = MinorThird,
		M3 = MajorThird,
		P4 = PerfectFourth,
		A4 = Tritone,
		d5 = Tritone,
		P5 = PerfectFifth,
		m6 = MinorSixth,
		M6 = MajorSixth,
		m7 = MinorSeventh,
		M7 = MajorSeventh,
		P8 = PerfectOctave,

		/* aliases set two */

		flat2 = MinorSecond,
		fourth = PerfectFourth,
		flat5 = Tritone,
		sharp5 = MinorSixth,
		dom7 = MinorSeventh,
		dblflat7 = MajorSixth,
	};
};

}
