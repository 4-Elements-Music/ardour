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

void
ChordProvider::build_12tet_chords ()
{
	TET12Chord c;

	c.name = _("maj");
	c.assign ({ROOT, MAJOR_THIRD, FIFTH });
	tet12_chords.push_back (c);

	c.name = _("min");
	c.assign ({ROOT, MINOR_THIRD, FIFTH });
	tet12_chords.push_back (c);

	c.name = _("sus4");
	c.assign ({ ROOT, FOURTH, FIFTH });
	tet12_chords.push_back (c);

	c.name = _("sus2");
	c.assign ({ ROOT, SECOND, FIFTH });
	tet12_chords.push_back (c);

	c.name = _("dim");
	c.assign ({ ROOT, MINOR_THIRD, FLAT_FIFTH });
	tet12_chords.push_back (c);

	c.name = _("aug");
	c.assign ({ ROOT, MAJOR_THIRD, SHARP_FIFTH });
	tet12_chords.push_back (c);
};
