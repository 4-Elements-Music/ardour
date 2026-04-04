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

#include "ardour/chord_provider.h"
#include "pbd/i18n.h"

using namespace ARDOUR;

ChordProvider::TET12Chords ChordProvider::tet12_chords;

template<typename...Names>
void
ChordProvider::register_12tet_chord (std::vector<int> const intervals, Names...chord_names)
{
	for (auto & chord_name : { chord_names... } ) {
		tet12_chords[chord_name] = intervals;
	}
}

void
ChordProvider::build_12tet_chords ()
{
	/* triads */

	register_12tet_chord ({ Unison, M3, P5 }, _("maj"), _("major"));
	register_12tet_chord ({ Unison, m3, P5 }, _("min"), _("minor"));
	register_12tet_chord ({ Unison, P4, P5 }, _("sus4"));
	register_12tet_chord ({ Unison, M2, P5 }, _("sus2"));
	register_12tet_chord ({ Unison, m3, d5 }, _("dim"));
	register_12tet_chord ({ Unison, M3, m6 }, _("aug"));

	/* tetrads */

	register_12tet_chord ({ Unison, M3, P5, M7 }, _("maj7"), _("7"));
	register_12tet_chord ({ Unison, m3, P5, m7 }, _("min7"), _("dom7"));
	register_12tet_chord ({ Unison, M3, d5, m7 }, _("min7/b5"));
	register_12tet_chord ({ Unison, M3, m6, M7 }, _("aug7"));
	register_12tet_chord ({ Unison, m3, d5, m7 }, _("dim7"));
	register_12tet_chord ({ Unison, m3, P5, m6 }, _("min6"));
	register_12tet_chord ({ Unison, M3, P5, M6 }, _("maj6"));
}
